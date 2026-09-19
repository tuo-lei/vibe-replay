import { describe, expect, it } from "vitest";
import {
  decryptFrame,
  encryptFrame,
  exportKeyString,
  generateContentKey,
  importKeyString,
  randomBoxId,
} from "../src/relay-crypto.js";

describe("relay-crypto", () => {
  it("round-trips a frame", async () => {
    const { key } = await generateContentKey();
    const boxId = randomBoxId();
    const frame = await encryptFrame(key, boxId, '{"seq":1,"cmd":"list"}');
    expect(frame.iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(frame.data).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decryptFrame(key, boxId, frame)).toBe('{"seq":1,"cmd":"list"}');
  });

  it("produces fresh IVs per frame", async () => {
    const { key } = await generateContentKey();
    const boxId = randomBoxId();
    const a = await encryptFrame(key, boxId, "same");
    const b = await encryptFrame(key, boxId, "same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("rejects decryption with the wrong key", async () => {
    const { key } = await generateContentKey();
    const { key: other } = await generateContentKey();
    const boxId = randomBoxId();
    const frame = await encryptFrame(key, boxId, "secret");
    await expect(decryptFrame(other, boxId, frame)).rejects.toThrow();
  });

  it("binds frames to the box id via AAD", async () => {
    const { key } = await generateContentKey();
    const frame = await encryptFrame(key, randomBoxId(), "secret");
    await expect(decryptFrame(key, randomBoxId(), frame)).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const { key } = await generateContentKey();
    const boxId = randomBoxId();
    const frame = await encryptFrame(key, boxId, "secret");
    const tampered = {
      ...frame,
      data: frame.data.slice(0, -2) + (frame.data.endsWith("AA") ? "BB" : "AA"),
    };
    await expect(decryptFrame(key, boxId, tampered)).rejects.toThrow();
  });

  it("exports and re-imports keys as 43-char base64url", async () => {
    const { key, raw } = await generateContentKey();
    const s = exportKeyString(raw);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const reimported = await importKeyString(s);
    const boxId = randomBoxId();
    const frame = await encryptFrame(key, boxId, "hello");
    expect(await decryptFrame(reimported, boxId, frame)).toBe("hello");
  });

  it("rejects malformed key strings", async () => {
    await expect(importKeyString("too-short")).rejects.toThrow();
    await expect(importKeyString("!".repeat(43))).rejects.toThrow();
  });

  it("generates unique unguessable box ids", () => {
    const ids = new Set(Array.from({ length: 100 }, randomBoxId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
