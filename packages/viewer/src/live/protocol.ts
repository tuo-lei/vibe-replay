/**
 * Live relay protocol client for `vibe-replay relay` share URLs.
 *
 * Mirrors the command set the VM shipper speaks (list/get/search/tail/
 * untail/ping). All frames are AES-256-GCM encrypted in the browser with the
 * key from the URL fragment (`location.hash`); the relay only forwards
 * ciphertext. Presence display names are encrypted the same way: the hello
 * carries `{iv, data}` ciphertext, the relay stores and broadcasts it
 * verbatim, and every viewer decrypts names locally — the relay never sees a
 * name in plaintext. Responses too large for one frame arrive chunked
 * (`chunk`/`chunks` inside the encrypted payload) and are reassembled here.
 * Ported from the original hand-rolled viewer page so the React live viewer
 * reuses the exact same wire protocol.
 */
import type { Scene } from "../types";

export interface RelaySessionSummary {
  provider: string;
  sessionId: string;
  title?: string;
  project: string;
  timestamp: string;
  promptCount?: number;
  toolCallCount?: number;
  model?: string;
}

export interface RelayGetResult {
  scenes: Scene[];
  totalScenes: number;
  offset: number;
}

export interface RelaySearchHit {
  sessionId: string;
  title?: string;
  provider: string;
  snippet: string;
}

export type TailEvent =
  | { event: "tail"; id: string; newScenes: Scene[] }
  | { event: "tail-gap"; id: string; skipped: number };

/** One entry of the relay-broadcast presence roster. */
export interface ViewerPresence {
  vid: string;
  name: string;
}

/**
 * Encrypted display name as carried in hello and presence broadcasts.
 * AES-GCM ciphertext (base64url) produced with the share URL fragment key —
 * opaque to the relay, decrypted locally by every viewer.
 */
export interface NameCipher {
  iv: string;
  data: string;
}

/** Display names are normalized in the browser before encryption. */
export const MAX_NAME_CHARS = 32;

/**
 * Normalize a raw display name: strip control characters, trim, cap at
 * MAX_NAME_CHARS. Falls back to "Guest" for empty input. Applied in the
 * browser (which encrypts the result) and again after decrypting a roster
 * name, so a malicious peer can never inject control characters into the UI.
 */
export function normalizeName(raw: string): string {
  const cleaned = raw.replace(/\p{Cc}/gu, "").trim();
  return cleaned.slice(0, MAX_NAME_CHARS) || "Guest";
}

export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const BOX_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const COMMAND_TIMEOUT_MS = 30_000;
/**
 * Viewer heartbeat cadence. Must stay well under the relay's
 * PRESENCE_SWEEP_AFTER_MS (45 s) — keep in sync with
 * cloudflare/src/live-relay.ts HEARTBEAT_INTERVAL_MS.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Chunked command responses: hard cap on chunks per command (mirrors the shipper). */
const MAX_CHUNKS = 64;

export function b64urlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Extract the box id from a `/live/<boxId>` path. Returns null when invalid. */
export function boxIdFromPath(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  return BOX_ID_RE.test(seg) ? seg : null;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal surface LiveApp needs. LiveClient implements it; tests inject a
 * fake. Keeps the UI decoupled from the socket.
 */
export interface LiveRelay {
  list(): Promise<RelaySessionSummary[]>;
  get(sessionId: string, offset: number, limit: number): Promise<RelayGetResult>;
  search(q: string, limit?: number): Promise<RelaySearchHit[]>;
  tail(sessionId: string): Promise<{ totalScenes: number }>;
  untail(sessionId: string): Promise<void>;
  onTail(handler: (ev: TailEvent) => void): () => void;
  /**
   * Fired when the relay broadcasts the viewer roster (on join/leave) and
   * right after connect with our own vid. `selfVid` is null until the
   * relay's `welcome` arrives.
   */
  onPresence(handler: (viewers: ViewerPresence[], selfVid: string | null) => void): () => void;
  /**
   * Fired when the socket drops unexpectedly (not via close()). The app uses
   * it to re-establish the session automatically instead of stranding the
   * viewer on a terminal error. The close code/reason are included for
   * diagnostics.
   */
  onDisconnect(handler: (info: DisconnectInfo) => void): () => void;
  /**
   * Fired when the relay declares the box permanently dead: the shipper is
   * gone and won't come back (a restart mints a new box id, so the old URL
   * never revives). The UI must show the "session ended" page and must NOT
   * retry — reconnecting to this box can never succeed.
   */
  onSessionEnded(handler: () => void): () => void;
  close(): void;
}

/** What the relay reported when the socket closed. */
export interface DisconnectInfo {
  code: number;
  reason: string;
}

export class LiveClient implements LiveRelay {
  private ws: WebSocket;
  private key: CryptoKey;
  private boxId: string;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private tailHandlers = new Set<(ev: TailEvent) => void>();
  private disconnectHandlers = new Set<(info: DisconnectInfo) => void>();
  private sessionEndedHandlers = new Set<() => void>();
  private presenceHandlers = new Set<(viewers: ViewerPresence[], selfVid: string | null) => void>();
  /** Roster from the last relay `presence` broadcast. */
  private presence: ViewerPresence[] = [];
  /** Our own viewer id, from the relay's `welcome`. Null until it arrives. */
  private selfVid: string | null = null;
  /** Generation counter: concurrent presence handlers must not let an older
   *  broadcast's async decryptions overwrite a newer roster. */
  private presenceGen = 0;
  /** In-flight chunked command responses, keyed by command seq. */
  private chunkBufs = new Map<number, { chunks: number; parts: string[]; received: number }>();
  private closed = false;
  /** True once close() was called — suppresses the disconnect handlers. */
  private intentionalClose = false;
  /** Liveness pings to the relay (`{t:"heartbeat"}`), so the relay's sweep
   *  never mistakes a healthy viewer for a ghost. Started after hello. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(ws: WebSocket, key: CryptoKey, boxId: string) {
    this.ws = ws;
    this.key = key;
    this.boxId = boxId;
  }

  /**
   * Connect as a viewer. Reads the content key from `location.hash`, opens
   * the WebSocket to the same host, and says hello with the display name
   * AES-GCM-encrypted (the relay only ever sees the ciphertext — it stores
   * and broadcasts it verbatim and other viewers decrypt it locally).
   * Throws on a missing or malformed key, or when the socket cannot be
   * established.
   */
  static async connect(boxId: string, name: string): Promise<LiveClient> {
    const keyB64 = (location.hash || "").replace(/^#/, "");
    if (!KEY_RE.test(keyB64)) throw new Error("invalid-share-url");
    const raw = b64urlDecode(keyB64);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/live/${boxId}`);
    const client = new LiveClient(ws, key, boxId);
    const nameCipher = await client.encryptName(normalizeName(name));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // A socket that times out or errors must never later trigger onopen and
      // send hello: clear the setup handlers and close it before rejecting.
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onopen = null;
        ws.onerror = null;
        ws.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("connection-timeout")), 15_000);
      ws.onopen = () => {
        if (settled) {
          ws.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.onopen = null;
        ws.onerror = null;
        ws.send(JSON.stringify({ t: "hello", role: "viewer", name: nameCipher }));
        client.startHeartbeat();
        resolve();
      };
      ws.onerror = () => fail(new Error("connection-error"));
    });
    ws.onmessage = (e) => void client.handleMessage(e);
    ws.onclose = (ev) => client.handleClose({ code: ev.code, reason: ev.reason });
    ws.onerror = () => client.handleClose({ code: 0, reason: "" });
    return client;
  }

  private aad(): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`vibe-replay-live:v1:${this.boxId}`);
  }

  private async encryptFrame(payload: Record<string, unknown>): Promise<void> {
    const pt = new TextEncoder().encode(JSON.stringify(payload));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad() },
      this.key,
      pt,
    );
    this.ws.send(
      JSON.stringify({ t: "frame", iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) }),
    );
  }

  private async decryptFrame(ivB64: string, dataB64: string): Promise<Record<string, unknown>> {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivB64), additionalData: this.aad() },
      this.key,
      b64urlDecode(dataB64),
    );
    return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
  }

  /** Encrypt the normalized display name for the hello handshake. */
  private async encryptName(displayName: string): Promise<NameCipher> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad() },
      this.key,
      new TextEncoder().encode(displayName),
    );
    return { iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) };
  }

  /**
   * Decrypt one roster name. Corrupt, missing, or foreign-key ciphertext
   * degrades to "Guest" — a malicious or broken peer must never break the
   * roster UI. Legacy plaintext names pass through normalized.
   */
  private async decryptName(v: unknown): Promise<string> {
    try {
      if (typeof v === "string") return normalizeName(v);
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as Record<string, unknown>).iv === "string" &&
        typeof (v as Record<string, unknown>).data === "string"
      ) {
        const pt = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: b64urlDecode((v as Record<string, unknown>).iv as string),
            additionalData: this.aad(),
          },
          this.key,
          b64urlDecode((v as Record<string, unknown>).data as string),
        );
        return normalizeName(new TextDecoder().decode(pt));
      }
    } catch {
      // fall through to Guest
    }
    return "Guest";
  }

  /**
   * Accumulate one chunk of a chunked command response. The shipper splits
   * responses that don't fit a single frame; chunks are grouped by command
   * seq and reassembled here before the pending command resolves. Malformed
   * chunk metadata is dropped — the command simply times out on the
   * existing COMMAND_TIMEOUT_MS path.
   */
  private accumulateChunk(seq: number, chunk: number, chunks: number, data: unknown): void {
    if (
      !Number.isInteger(chunk) ||
      !Number.isInteger(chunks) ||
      chunk < 0 ||
      chunk >= chunks ||
      chunks > MAX_CHUNKS
    )
      return;
    if (typeof data !== "string") return;
    const p = this.pending.get(seq);
    if (!p) return; // unknown or already-timed-out command
    let buf = this.chunkBufs.get(seq);
    if (!buf) {
      buf = { chunks, parts: Array.from<string>({ length: chunks }), received: 0 };
      this.chunkBufs.set(seq, buf);
    }
    if (buf.chunks !== chunks || buf.parts[chunk] !== undefined) return;
    buf.parts[chunk] = data;
    buf.received += 1;
    if (buf.received === buf.chunks) {
      this.chunkBufs.delete(seq);
      this.pending.delete(seq);
      try {
        p.resolve(JSON.parse(buf.parts.join("")) as Record<string, unknown>);
      } catch {
        p.reject(new Error("invalid chunked response"));
      }
    }
  }

  private emitPresence(): void {
    const snapshot = this.presence.map((v) => ({ ...v }));
    for (const h of this.presenceHandlers) {
      try {
        h(snapshot, this.selfVid);
      } catch {
        // a failing handler must not break the others
      }
    }
  }

  private async handleMessage(e: MessageEvent): Promise<void> {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(String(e.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    // Plaintext relay control frames (routing metadata, like the hello).
    if (outer.t === "welcome" && typeof outer.vid === "string") {
      this.selfVid = outer.vid;
      this.emitPresence();
      return;
    }
    if (outer.t === "presence" && Array.isArray(outer.viewers)) {
      // Roster names arrive as ciphertext ({iv, data}) the relay forwarded
      // verbatim; decrypt each locally with the fragment key. Handlers run
      // concurrently per message, so a generation guard keeps an older
      // broadcast from overwriting a newer roster after slow decryptions.
      const gen = ++this.presenceGen;
      const roster: ViewerPresence[] = [];
      for (const v of outer.viewers) {
        if (typeof v !== "object" || v === null || typeof v.vid !== "string") continue;
        roster.push({
          vid: (v.vid as string).slice(0, 64),
          name: await this.decryptName((v as Record<string, unknown>).name),
        });
      }
      if (gen !== this.presenceGen) return; // superseded by a newer broadcast
      this.presence = roster;
      this.emitPresence();
      return;
    }
    // The relay declared the box permanently dead (shipper gone for good).
    // Reconnecting is pointless — the UI shows the "session ended" page.
    if (outer.t === "session-ended") {
      this.handleSessionEnded();
      return;
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string")
      return;
    let inner: Record<string, unknown>;
    try {
      inner = await this.decryptFrame(outer.iv, outer.data);
    } catch {
      return; // not for us (or wrong key) — ignore
    }
    if (inner.event === "tail" || inner.event === "tail-gap") {
      const ev = inner as unknown as TailEvent;
      for (const h of this.tailHandlers) h(ev);
      return;
    }
    if (typeof inner.chunk === "number" && typeof inner.chunks === "number") {
      this.accumulateChunk(inner.seq as number, inner.chunk, inner.chunks, inner.data);
      return;
    }
    const p = this.pending.get(inner.seq as number);
    if (p) {
      this.pending.delete(inner.seq as number);
      this.chunkBufs.delete(inner.seq as number);
      p.resolve(inner);
    }
  }

  /**
   * The relay declared the box permanently dead. Fail every in-flight
   * command with the fatal "session-ended" marker (so the app's connect
   * loop treats it like an invalid URL instead of retrying), notify the
   * UI, and close the socket — no reconnect is scheduled.
   */
  private handleSessionEnded(): void {
    if (this.closed) return;
    this.intentionalClose = true;
    for (const [, p] of this.pending) p.reject(new Error("session-ended"));
    this.pending.clear();
    this.chunkBufs.clear();
    for (const h of this.sessionEndedHandlers) {
      try {
        h();
      } catch {
        // a failing handler must not break the others
      }
    }
    this.close();
  }

  private handleClose(info: DisconnectInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    for (const [, p] of this.pending) p.reject(new Error("disconnected"));
    this.pending.clear();
    this.chunkBufs.clear();
    if (this.intentionalClose) return;
    for (const h of this.disconnectHandlers) {
      try {
        h(info);
      } catch {
        // a failing handler must not break the others
      }
    }
  }

  /**
   * Prove liveness to the relay so its sweep never reaps a healthy viewer.
   * Plaintext `{t:"heartbeat"}` — relay-visible routing metadata like hello,
   * carrying nothing private. The relay sweeps viewers silent past 45 s, so
   * this fires every HEARTBEAT_INTERVAL_MS (15 s) with wide margin.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ t: "heartbeat" }));
      } catch {
        // send failed — the close handler will clean up
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cmd<T>(obj: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("disconnected"));
        return;
      }
      this.seq += 1;
      const seq = this.seq;
      obj.seq = seq;
      this.pending.set(seq, {
        resolve: (v) => resolve(v as unknown as T),
        reject,
      });
      this.encryptFrame(obj).catch(reject);
      setTimeout(() => {
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          this.chunkBufs.delete(seq);
          p.reject(new Error("timeout"));
        }
      }, COMMAND_TIMEOUT_MS);
    });
  }

  async list(): Promise<RelaySessionSummary[]> {
    const res = await this.cmd<{
      ok: boolean;
      error?: string;
      data: { sessions: RelaySessionSummary[] };
    }>({
      cmd: "list",
    });
    if (!res.ok) throw new Error(res.error || "list failed");
    return res.data.sessions;
  }

  async get(sessionId: string, offset: number, limit: number): Promise<RelayGetResult> {
    const res = await this.cmd<{
      ok: boolean;
      error?: string;
      data: { scenes: Scene[]; totalScenes: number; offset: number };
    }>({ cmd: "get", id: sessionId, offset, limit });
    if (!res.ok) throw new Error(res.error || "get failed");
    return res.data;
  }

  async search(q: string, limit = 10): Promise<RelaySearchHit[]> {
    const res = await this.cmd<{ ok: boolean; error?: string; data: { hits: RelaySearchHit[] } }>({
      cmd: "search",
      q,
      limit,
    });
    if (!res.ok) throw new Error(res.error || "search failed");
    return res.data.hits;
  }

  /** Subscribe to live scene appends. Returns the shipper's scene count. */
  async tail(sessionId: string): Promise<{ totalScenes: number }> {
    const res = await this.cmd<{ ok: boolean; error?: string; data: { totalScenes: number } }>({
      cmd: "tail",
      id: sessionId,
    });
    if (!res.ok) throw new Error(res.error || "tail failed");
    return res.data;
  }

  async untail(sessionId: string): Promise<void> {
    try {
      await this.cmd<{ ok: boolean }>({ cmd: "untail", id: sessionId });
    } catch {
      // best-effort: the socket may already be gone
    }
  }

  onTail(handler: (ev: TailEvent) => void): () => void {
    this.tailHandlers.add(handler);
    return () => this.tailHandlers.delete(handler);
  }

  onPresence(handler: (viewers: ViewerPresence[], selfVid: string | null) => void): () => void {
    this.presenceHandlers.add(handler);
    // Replay the latest roster immediately: it usually arrives during the
    // initial list() round-trip, before the UI subscribes. Without this the
    // roster would stay empty until the next join/leave broadcast.
    try {
      handler(
        this.presence.map((v) => ({ ...v })),
        this.selfVid,
      );
    } catch {
      // a failing handler must not break the subscription
    }
    return () => this.presenceHandlers.delete(handler);
  }

  onDisconnect(handler: (info: DisconnectInfo) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  onSessionEnded(handler: () => void): () => void {
    this.sessionEndedHandlers.add(handler);
    return () => this.sessionEndedHandlers.delete(handler);
  }

  close(): void {
    this.intentionalClose = true;
    this.handleClose({ code: 1000, reason: "closed" });
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
