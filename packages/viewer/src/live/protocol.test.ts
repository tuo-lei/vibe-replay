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
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
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
          { vid: "v-self", name: await encryptNameFor(key, "test-box", "Lei") },
          { vid: "v-other", name: await encryptNameFor(key, "test-box", "Wendy") },
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
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");
    const seen: unknown[][] = [];
    client.onPresence((viewers: unknown) => {
      seen.push(viewers as unknown[]);
    });
    // Immediate replay of the (empty) initial roster.
    expect(seen).toHaveLength(1);
    await client.handleMessage({
      data: JSON.stringify({
        t: "presence",
        viewers: [{ vid: "v1", name: await encryptNameFor(key, "test-box", "Lei") }],
      }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([{ vid: "v1", name: "Lei" }]);
  });

  it("decrypts each viewer's name locally; corrupt ciphertext becomes Guest", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");
    const good = await encryptNameFor(key, "test-box", "Wendy");
    // Tamper with one character of the ciphertext: GCM auth must fail.
    const badData = good.data.slice(0, -2) + (good.data.endsWith("A") ? "B" : "A");
    const seen: unknown[][] = [];
    client.onPresence((viewers: unknown) => {
      seen.push(viewers as unknown[]);
    });
    await client.handleMessage({
      data: JSON.stringify({
        t: "presence",
        viewers: [
          { vid: "v-good", name: good },
          { vid: "v-bad", name: { iv: good.iv, data: badData } },
          { vid: "v-null", name: null },
          { vid: "v-legacy", name: "Lei" },
        ],
      }),
    });
    const roster = seen[seen.length - 1]!;
    expect(roster).toEqual([
      { vid: "v-good", name: "Wendy" },
      { vid: "v-bad", name: "Guest" },
      { vid: "v-null", name: "Guest" },
      { vid: "v-legacy", name: "Lei" },
    ]);
  });
});

describe("normalizeName", () => {
  it("strips control chars, trims, caps at 32 chars, defaults to Guest", async () => {
    const { normalizeName } = await import("./protocol");
    expect(normalizeName("  Lei  ")).toBe("Lei");
    expect(normalizeName("a\u0001b\u007fc")).toBe("abc");
    expect(normalizeName("x".repeat(100))).toBe("x".repeat(32));
    expect(normalizeName("   ")).toBe("Guest");
    expect(normalizeName("")).toBe("Guest");
  });
});

describe("LiveClient chunked responses", () => {
  it("reassembles a multi-chunk get response in order", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");

    const full = {
      ok: true,
      data: {
        scenes: Array.from({ length: 50 }, (_, i) => ({ n: i })),
        totalScenes: 50,
        offset: 0,
      },
    };
    const json = JSON.stringify(full);
    const mid = Math.floor(json.length / 3);
    const pieces = [json.slice(0, mid), json.slice(mid, 2 * mid), json.slice(2 * mid)];

    const pending = client.get("sess-1", 0, 5000);
    // Chunks arrive out of order; the client must still reassemble correctly.
    for (const i of [2, 0, 1]) {
      await client.handleMessage({
        data: JSON.stringify(
          await encryptFrameFor(key, "test-box", { seq: 1, chunk: i, chunks: 3, data: pieces[i] }),
        ),
      });
    }
    await expect(pending).resolves.toEqual(full.data);
  });

  it("ignores malformed chunks without breaking the pending command", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");

    const full = { ok: true, data: { scenes: [{ n: 1 }], totalScenes: 1, offset: 0 } };
    const json = JSON.stringify(full);
    const pending = client.get("sess-1", 0, 5000);
    // Malformed: chunk index out of range, non-string data, unknown seq.
    for (const bad of [
      { seq: 1, chunk: 7, chunks: 2, data: "x" },
      { seq: 1, chunk: 0, chunks: 2, data: 42 },
      { seq: 999, chunk: 0, chunks: 1, data: "x" },
    ]) {
      await client.handleMessage({
        data: JSON.stringify(await encryptFrameFor(key, "test-box", bad)),
      });
    }
    // The real chunks still resolve the command afterwards.
    const mid = Math.floor(json.length / 2);
    for (const i of [0, 1]) {
      await client.handleMessage({
        data: JSON.stringify(
          await encryptFrameFor(key, "test-box", {
            seq: 1,
            chunk: i,
            chunks: 2,
            data: i === 0 ? json.slice(0, mid) : json.slice(mid),
          }),
        ),
      });
    }
    await expect(pending).resolves.toEqual(full.data);
  });
});

/** Encrypt a roster display name the way the hello handshake does. */
async function encryptNameFor(key: CryptoKey, boxId: string, name: string) {
  const { b64urlEncode } = await import("./protocol");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`vibe-replay-live:v1:${boxId}`),
    },
    key,
    new TextEncoder().encode(name),
  );
  return { iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) };
}

/** Encrypt one command/response frame the way the shipper does. */
async function encryptFrameFor(key: CryptoKey, boxId: string, payload: unknown) {
  const { b64urlEncode } = await import("./protocol");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`vibe-replay-live:v1:${boxId}`),
    },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { t: "frame", iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) };
}

describe("LiveClient presence generation guard", () => {
  it("an older broadcast finishing later never overwrites a newer roster", async () => {
    const { LiveClient } = await import("./protocol");
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const fakeWs = { send: () => {}, close: () => {}, readyState: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: private constructor in tests
    const client: any = new (LiveClient as any)(fakeWs, key, "test-box");
    // Controllable decryptions: each call parks until its resolver fires.
    const resolvers: Array<() => void> = [];
    client.decryptName = (v: unknown) =>
      new Promise<string>((res) => {
        resolvers.push(() => res(typeof v === "string" ? v : "Guest"));
      });
    const seen: unknown[][] = [];
    client.onPresence((viewers: unknown) => {
      seen.push(viewers as unknown[]);
    });

    // Two broadcasts handled concurrently (ws.onmessage never awaits).
    const p1 = client.handleMessage({
      data: JSON.stringify({ t: "presence", viewers: [{ vid: "v1", name: "old" }] }),
    });
    const p2 = client.handleMessage({
      data: JSON.stringify({ t: "presence", viewers: [{ vid: "v2", name: "new" }] }),
    });
    // Finish the NEWER broadcast first, then the older one.
    resolvers[1]!();
    await p2;
    resolvers[0]!();
    await p1;

    const roster = seen[seen.length - 1]!;
    expect(roster).toEqual([{ vid: "v2", name: "new" }]);
  });
});
