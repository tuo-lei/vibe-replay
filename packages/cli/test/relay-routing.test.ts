import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The relay tags each viewer→VM frame with a plaintext `via` (the sender's
 * viewer id); the shipper must echo it back on its response so the relay can
 * route the reply to the right viewer. Crypto is mocked as a passthrough so
 * the test can craft inbound frames directly.
 */
vi.mock("../src/relay-crypto.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/relay-crypto.js")>();
  return {
    ...orig,
    encryptFrame: async (_key: unknown, _box: string, plaintext: string) => ({
      iv: "mock-iv",
      data: plaintext,
    }),
    decryptFrame: async (_key: unknown, _box: string, frame: { data: string }) => frame.data,
  };
});

// Fake provider/transform so tail commands don't touch the real filesystem.
const providerState = vi.hoisted(() => ({ discoverCalls: 0, scenes: [] as unknown[] }));
vi.mock("../src/providers/index.js", () => ({
  getAllProviders: () => [
    {
      name: "fake",
      discover: async () => {
        providerState.discoverCalls++;
        return [{ sessionId: "sess-1", provider: "fake", filePaths: [] as string[] }];
      },
      parse: async () => ({}),
    },
  ],
  deduplicateSessionsByProvider: (xs: unknown) => xs,
}));
vi.mock("../src/transform.js", () => ({
  transformToReplay: () => ({ scenes: providerState.scenes, meta: { stats: {} } }),
}));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);

const { startRelay } = await import("../src/relay.js");

afterEach(() => {
  FakeSocket.instances = [];
  providerState.scenes = [];
});

function lastOuter(sock: FakeSocket) {
  return JSON.parse(sock.sent[sock.sent.length - 1] ?? "{}") as Record<string, unknown>;
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(fn(), label).toBe(true);
}

describe("shipper viewer routing", () => {
  it("echoes the relay's `via` tag on command responses", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();
    expect(JSON.parse(sock.sent[0] ?? "{}")).toMatchObject({ t: "hello", role: "vm" });

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 7, cmd: "ping" }),
        via: "viewer-abc",
      }),
    });
    await waitFor(() => sock.sent.length > 1, "response sent");

    const outer = lastOuter(sock);
    expect(outer.via).toBe("viewer-abc");
    expect(JSON.parse(outer.data as string)).toMatchObject({ seq: 7, ok: true });
  });

  it("echoes `via` on error responses too", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 3, cmd: "get" }),
        via: "viewer-xyz",
      }),
    });
    await waitFor(() => sock.sent.length > 1, "error response sent");

    const outer = lastOuter(sock);
    expect(outer.via).toBe("viewer-xyz");
    expect(JSON.parse(outer.data as string)).toMatchObject({ seq: 3, ok: false });
  });

  it("omits `via` when the inbound frame had none (legacy single viewer)", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 1, cmd: "ping" }),
      }),
    });
    await waitFor(() => sock.sent.length > 1, "response sent");

    const outer = lastOuter(sock);
    expect("via" in outer).toBe(false);
    expect(JSON.parse(outer.data as string)).toMatchObject({ seq: 1, ok: true });
  });

  it("shares one tail poll loop between two viewers, keyed by `via`", async () => {
    providerState.discoverCalls = 0;
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    const tail = (seq: number, via: string) =>
      sock.onmessage!({
        data: JSON.stringify({
          t: "frame",
          iv: "mock-iv",
          data: JSON.stringify({ seq, cmd: "tail", id: "sess-1" }),
          via,
        }),
      });

    tail(1, "viewer-a");
    await waitFor(() => sock.sent.length > 1, "first tail subscribed");
    expect(JSON.parse(lastOuter(sock).data as string)).toMatchObject({
      seq: 1,
      ok: true,
      data: { subscribed: true },
    });
    const afterFirstTail = providerState.discoverCalls;
    expect(afterFirstTail).toBeGreaterThan(0);

    // A second viewer tails the same session: no new poll loop, and the
    // response is routed back to the second viewer only.
    tail(2, "viewer-b");
    await waitFor(() => sock.sent.length > 2, "second tail subscribed");
    const outer = lastOuter(sock);
    expect(outer.via).toBe("viewer-b");
    expect(JSON.parse(outer.data as string)).toMatchObject({ seq: 2, ok: true });
    expect(providerState.discoverCalls).toBe(afterFirstTail);
  });

  it("drops a departed viewer's tails on `viewer-left`", async () => {
    providerState.discoverCalls = 0;
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 1, cmd: "tail", id: "sess-1" }),
        via: "viewer-gone",
      }),
    });
    await waitFor(() => sock.sent.length > 1, "tail subscribed");
    const afterFirstTail = providerState.discoverCalls;
    expect(afterFirstTail).toBeGreaterThan(0);

    // The relay tells the shipper the viewer went away.
    sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "viewer-gone" }) });

    // A later tail for the same session starts a fresh poll loop instead of
    // rejoining a loop that still fans out to the departed viewer.
    await new Promise((r) => setTimeout(r, 50));
    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 2, cmd: "tail", id: "sess-1" }),
        via: "viewer-new",
      }),
    });
    await waitFor(() => sock.sent.length > 2, "re-subscribed");
    expect(providerState.discoverCalls).toBeGreaterThan(afterFirstTail);
  });
});

describe("shipper chunked responses", () => {
  it("splits an oversized get response into reassemblable chunks", async () => {
    // ~1KB per scene × 20000 scenes; the get page (5000 scenes) is ~5MB,
    // well over the 4MB single-frame cap.
    providerState.scenes = Array.from({ length: 20000 }, (_, i) => ({
      i,
      pad: "x".repeat(1000),
    }));
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 9, cmd: "get", id: "sess-1" }),
        via: "viewer-chunk",
      }),
    });
    await waitFor(() => sock.sent.length > 2, "chunks sent");

    const frames = sock.sent.slice(1).map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      // Every chunk echoes the routing tag and fits one frame.
      expect(f.via).toBe("viewer-chunk");
      expect(JSON.stringify(f).length).toBeLessThan(4 * 1024 * 1024);
    }
    const inners = frames.map((f) => JSON.parse(f.data as string) as Record<string, unknown>);
    const chunkCount = inners[0]!.chunks as number;
    expect(chunkCount).toBe(frames.length);
    const assembled = JSON.parse(
      inners
        .sort((a, b) => (a.chunk as number) - (b.chunk as number))
        .map((i) => i.data as string)
        .join(""),
    ) as Record<string, unknown>;
    expect(assembled).toMatchObject({ seq: 9, ok: true });
    const data = assembled.data as { totalScenes: number; scenes: unknown[] };
    expect(data.totalScenes).toBe(20000);
    expect(data.scenes).toHaveLength(5000);
  });

  it("still sends small responses as a single unchunked frame", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 5, cmd: "ping" }),
        via: "viewer-abc",
      }),
    });
    await waitFor(() => sock.sent.length > 1, "response sent");

    const frames = sock.sent.slice(1).map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames).toHaveLength(1);
    const inner = JSON.parse(frames[0]!.data as string) as Record<string, unknown>;
    expect(inner).toMatchObject({ seq: 5, ok: true });
    expect(inner).not.toHaveProperty("chunk");
  });
});

describe("shipper chunked responses (UTF-8 bytes)", () => {
  it("chunks by UTF-8 bytes, never tearing multi-byte text", async () => {
    // 5000 scenes × 300 CJK chars: ~1.6M UTF-16 code units but ~4.5MB in
    // UTF-8 — over the single-frame cap in bytes, under it in units. A
    // unit-counting splitter would wrongly send this as one 4.5MB frame
    // (the relay measures UTF-8 bytes and would kill the socket).
    providerState.scenes = Array.from({ length: 20000 }, (_, i) => ({
      i,
      pad: "中".repeat(300),
    }));
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 11, cmd: "get", id: "sess-1" }),
        via: "viewer-cjk",
      }),
    });
    await waitFor(() => sock.sent.length > 2, "chunks sent");

    const frames = sock.sent.slice(1).map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(Buffer.byteLength(JSON.stringify(f), "utf8")).toBeLessThan(4 * 1024 * 1024);
    }
    const inners = frames.map((f) => JSON.parse(f.data as string) as Record<string, unknown>);
    const assembled = JSON.parse(
      inners
        .sort((a, b) => (a.chunk as number) - (b.chunk as number))
        .map((i) => i.data as string)
        .join(""),
    ) as Record<string, unknown>;
    expect(assembled).toMatchObject({ seq: 11, ok: true });
    // No torn surrogate/CJK sequences: the reassembled JSON parses and the
    // CJK padding survives byte-exact.
    const data = assembled.data as { scenes: Array<{ pad: string }> };
    expect(data.scenes).toHaveLength(5000);
    expect(data.scenes[0]!.pad).toBe("中".repeat(300));
  });
});
