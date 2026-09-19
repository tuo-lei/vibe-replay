/**
 * E2E crypto for `vibe-replay relay`.
 *
 * Design (borrowed from Excalidraw's share-link model):
 * - The VM (shipper) generates a random 256-bit AES-GCM content key per
 *   `relay` invocation. The key is embedded in the share URL *fragment*
 *   (`https://<relay>/live/<boxId>#<key>`) and is never sent to the relay —
 *   fragments are never included in HTTP requests.
 * - Every command and response payload is AES-256-GCM encrypted. The relay
 *   only ever sees opaque `{t:"frame", iv, data}` envelopes and forwards them
 *   verbatim, exactly like excalidraw-room's `encryptedData` passthrough.
 * - AAD binds each frame to its box id, so a frame captured from one box
 *   cannot be replayed into another box's session.
 *
 * Security does not depend on code secrecy (this repo is open source): it
 * comes from per-invocation random keys + URL-fragment semantics + AES-GCM.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const BOX_ID_BYTES = 16;

function base64urlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, "base64url");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function aadFor(boxId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`vibe-replay-live:v1:${boxId}`);
}

/** Unguessable routing id. Also used as the AAD domain separator. */
export function randomBoxId(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(BOX_ID_BYTES)));
}

export interface ContentKey {
  key: CryptoKey;
  raw: Uint8Array<ArrayBuffer>;
}

export async function generateContentKey(): Promise<ContentKey> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, raw };
}

export function exportKeyString(raw: Uint8Array<ArrayBuffer>): string {
  if (raw.length !== KEY_BYTES) throw new Error("invalid key length");
  return base64urlEncode(raw);
}

export async function importKeyString(s: string): Promise<CryptoKey> {
  const raw = base64urlDecode(s);
  if (raw.length !== KEY_BYTES) throw new Error("invalid key: must be 43 base64url chars");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface EncryptedFrame {
  iv: string;
  data: string;
}

/** Encrypt a UTF-8 JSON payload for the given box. */
export async function encryptFrame(
  key: CryptoKey,
  boxId: string,
  plaintext: string,
): Promise<EncryptedFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(boxId) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: base64urlEncode(iv), data: base64urlEncode(new Uint8Array(ct)) };
}

/** Decrypt a frame. Throws when the key, box id, or integrity check mismatches. */
export async function decryptFrame(
  key: CryptoKey,
  boxId: string,
  frame: EncryptedFrame,
): Promise<string> {
  const iv = base64urlDecode(frame.iv);
  const data = base64urlDecode(frame.data);
  if (iv.length !== IV_BYTES) throw new Error("invalid iv");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(boxId) },
    key,
    data,
  );
  return new TextDecoder().decode(pt);
}
