import { describe, expect, it } from "vitest";
import { BOX_ID_RE, KEY_RE, b64urlDecode, b64urlEncode, boxIdFromPath } from "./protocol";

describe("b64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
  });

  it("produces URL-safe output (no +/= characters)", () => {
    // 0xfb 0xff 0xfe encodes with + and / in standard base64
    const out = b64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe, 0xfb]));
    expect(out).not.toMatch(/[+/=]/);
    expect(b64urlDecode(out)).toEqual(new Uint8Array([0xfb, 0xff, 0xfe, 0xfb]));
  });

  it("decodes unpadded input", () => {
    expect(b64urlDecode(b64urlEncode(new Uint8Array([1, 2, 3, 4, 5])))).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });
});

describe("boxIdFromPath", () => {
  it("extracts a valid 22-char box id from /live/<id>", () => {
    expect(boxIdFromPath("/live/x2KJPqQxznNNftBLSHV5jA")).toBe("x2KJPqQxznNNftBLSHV5jA");
  });

  it("rejects invalid paths", () => {
    expect(boxIdFromPath("/live/too-short")).toBeNull();
    expect(boxIdFromPath("/live/")).toBeNull();
    expect(boxIdFromPath("/")).toBeNull();
    expect(boxIdFromPath("/live/x2KJPqQxznNNftBLSHV5jA/extra")).toBeNull();
  });
});

describe("key/box id shapes", () => {
  it("accepts a 43-char base64url key", () => {
    expect(KEY_RE.test("7-Q6YnyzITT66759Cb4PZcCjlzXobfbK_3QKavTr2Nc")).toBe(true);
    expect(KEY_RE.test("short")).toBe(false);
    expect(KEY_RE.test("7-Q6YnyzITT66759Cb4PZcCjlzXobfbK_3QKavTr2Nc!")).toBe(false);
  });

  it("accepts a 22-char base64url box id", () => {
    expect(BOX_ID_RE.test("x2KJPqQxznNNftBLSHV5jA")).toBe(true);
    expect(BOX_ID_RE.test("x2KJPqQxznNNftBLSHV5j")).toBe(false);
  });
});

describe("LiveClient presence replay", () => {
  it("replays the latest roster to a subscriber that arrives after the broadcast", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {} };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");
    // The relay broadcasts welcome + presence while the UI is still awaiting
    // the initial list(), i.e. before it subscribes to onPresence.
    await client.handleMessage({
      data: JSON.stringify({ t: "welcome", vid: "v-self" }),
    });
    await client.handleMessage({
      data: JSON.stringify({
        t: "presence",
        viewers: [
          { vid: "v-self", name: "Lei" },
          { vid: "v-other", name: "Wendy" },
        ],
      }),
    });
    const calls: Array<{ viewers: unknown; self: unknown }> = [];
    client.onPresence((viewers: unknown, self: unknown) => {
      calls.push({ viewers, self });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.self).toBe("v-self");
    expect(calls[0]!.viewers).toEqual([
      { vid: "v-self", name: "Lei" },
      { vid: "v-other", name: "Wendy" },
    ]);
  });

  it("still emits later broadcasts to existing subscribers", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {} };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");
    const seen: unknown[][] = [];
    client.onPresence((viewers: unknown) => {
      seen.push(viewers as unknown[]);
    });
    // Immediate replay of the (empty) initial roster.
    expect(seen).toHaveLength(1);
    await client.handleMessage({
      data: JSON.stringify({ t: "presence", viewers: [{ vid: "v1", name: "Lei" }] }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([{ vid: "v1", name: "Lei" }]);
  });
});
