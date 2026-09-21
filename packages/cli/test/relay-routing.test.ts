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
const providerState = vi.hoisted(() => ({
  discoverCalls: 0,
  scenes: [] as unknown[],
  sessionInfo: {
    sessionId: "sess-1",
    provider: "fake",
    filePaths: [] as string[],
    title: "Fake session",
    project: "/tmp/proj",
    timestamp: "2026-09-20T00:00:00.000Z",
    lineCount: 10,
    fileSize: 512,
    promptCount: 2,
    toolCallCount: 5,
    model: "fake-model",
    gitRepo: "owner/repo",
    gitBranch: "feat/x",
    compactionCount: 1,
    durationMsEst: 60000,
    editCountEst: 3,
    prompts: ["short prompt", "x".repeat(500)],
  },
}));
vi.mock("../src/providers/index.js", () => ({
  getAllProviders: () => [
    {
      name: "fake",
      discover: async () => {
        providerState.discoverCalls++;
        return [providerState.sessionInfo];
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

describe("shipper dead-box retry exit", () => {
  function mockExits() {
    const exits: unknown[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code);
      throw new Error(`process.exit(${code})`);
    }) as never);
    return exits;
  }

  it("exits instead of retrying forever once a once-live box is certainly dead", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!(); // the box was live once

    const exits = mockExits();
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      // The relay connection drops and never recovers.
      sock.onclose!();
      // Jump past the 150 s dead-box exit (the relay's end grace is 90 s).
      vi.setSystemTime(t0 + 160_000);
      await vi.advanceTimersByTimeAsync(60_000); // let pending retries fire
      const retrySock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
      expect(retrySock).not.toBe(sock);
      expect(() => retrySock.onclose!()).toThrow("process.exit(0)");
      expect(exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("keeps retrying when it never connected (the relay may not be up yet)", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    // Never opens: no box existed yet, so there is nothing to declare dead.

    const exits = mockExits();
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0);
      sock.onclose!();
      vi.setSystemTime(t0 + 600_000);
      await vi.advanceTimersByTimeAsync(120_000);
      const retrySock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
      expect(() => retrySock.onclose!()).not.toThrow();
      expect(exits).toEqual([]);
      // A retry was still attempted: the shipper keeps dialing.
      expect(FakeSocket.instances.length).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a short outage keeps retrying with the same box id", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    const exits = mockExits();
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.setSystemTime(t0 + 10_000);
      expect(() => sock.onclose!()).not.toThrow();
      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("a transient drop on a long-lived connection retries instead of exiting", async () => {
    // Regression: the outage clock used to start when the connection was
    // *established*, so a deploy blip on a 9-minute-old connection exited
    // immediately instead of riding the normal reconnect path.
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();

    const exits = mockExits();
    try {
      vi.useFakeTimers();
      const t0 = Date.now();
      // The connection lived 559 s, then dropped (deploy restart / proxy).
      vi.setSystemTime(t0 + 559_000);
      expect(() => sock.onclose!()).not.toThrow();
      expect(exits).toEqual([]);
      // It dials again with the same box id instead of giving up.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeSocket.instances.length).toBe(2);
      // The retry connects: the outage clock resets and the box survives.
      const retrySock = FakeSocket.instances[1]!;
      vi.setSystemTime(t0 + 562_000);
      retrySock.onopen!();
      expect(exits).toEqual([]);
      // A later drop starts a fresh outage clock (no exit for a short blip).
      vi.setSystemTime(t0 + 900_000);
      expect(() => retrySock.onclose!()).not.toThrow();
      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe("shipper hello gating", () => {
  it("prints the share URL only after the relay acks the hello", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      void startRelay({ relayOrigin: "http://localhost:1" });
      await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
      const sock = FakeSocket.instances[0]!;
      sock.onopen!();
      expect(JSON.parse(sock.sent[0] ?? "{}")).toMatchObject({ t: "hello", role: "vm" });
      // The relay hasn't acked the hello yet: no share URL may be printed.
      await new Promise((r) => setTimeout(r, 50));
      expect(logs.some((l) => l.includes("Share this URL"))).toBe(false);
      // The relay acks the hello → now the URL is printed.
      sock.onmessage!({ data: JSON.stringify({ t: "hello-ok" }) });
      await waitFor(
        () => logs.some((l) => l.includes("Share this URL")),
        "URL printed after hello-ok",
      );
      expect(logs.join("\n")).toMatch(/live\/[A-Za-z0-9_-]+#/);
    } finally {
      console.log = origLog;
    }
  });
});

describe("shipper list summaries", () => {
  it("ships the shared RelaySessionSummary fields (filter/card data)", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[0]!;
    sock.onopen!();
    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 9, cmd: "list" }),
      }),
    });
    await waitFor(() => sock.sent.length > 1, "list response sent");
    const outer = lastOuter(sock);
    const payload = JSON.parse(outer.data as string) as {
      seq: number;
      ok: boolean;
      data: { sessions: Record<string, unknown>[] };
    };
    expect(payload).toMatchObject({ seq: 9, ok: true });
    expect(payload.data.sessions).toHaveLength(1);
    // The shared type lives in @vibe-replay/types; the shipper must populate
    // the fields the live viewer's filters and cards render.
    expect(payload.data.sessions[0]).toMatchObject({
      provider: "fake",
      sessionId: "sess-1",
      title: "Fake session",
      project: "/tmp/proj",
      timestamp: "2026-09-20T00:00:00.000Z",
      lineCount: 10,
      fileSize: 512,
      promptCount: 2,
      toolCallCount: 5,
      model: "fake-model",
      gitRepo: "owner/repo",
      gitBranch: "feat/x",
      compactionCount: 1,
      durationMsEst: 60000,
      editCountEst: 3,
    });
  });

  it("truncates each prompt preview so one huge prompt can't blow the frame budget", async () => {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.onopen!();
    sock.onmessage!({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 10, cmd: "list" }),
      }),
    });
    await waitFor(() => sock.sent.length > 1, "list response sent");
    const outer = lastOuter(sock);
    const payload = JSON.parse(outer.data as string) as {
      seq: number;
      ok: boolean;
      data: { sessions: Record<string, unknown>[] };
    };
    const firstPrompts = payload.data.sessions[0]!["firstPrompts"] as string[];
    expect(firstPrompts).toHaveLength(2);
    expect(firstPrompts[0]).toBe("short prompt");
    // 500-char prompt truncated to 300 + ellipsis.
    expect(firstPrompts[1]!.length).toBe(301);
    expect(firstPrompts[1]!.endsWith("…")).toBe(true);
  });
});

describe("shipper viewer presence", () => {
  function captureLogs() {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    return { logs, restore: () => void (console.log = origLog) };
  }

  async function connectedShipper(viewers?: number): Promise<FakeSocket> {
    void startRelay({ relayOrigin: "http://localhost:1" });
    await waitFor(() => FakeSocket.instances.length > 0, "shipper dials out");
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.onopen!();
    // Ack the hello the way a current relay does (older relays omit
    // `viewers`).
    sock.onmessage!(
      typeof viewers === "number"
        ? { data: JSON.stringify({ t: "hello-ok", viewers }) }
        : { data: JSON.stringify({ t: "hello-ok" }) },
    );
    await new Promise((r) => setTimeout(r, 20));
    return sock;
  }

  const presenceLines = (logs: string[]) => logs.filter((l) => l.includes("→ viewer"));

  it("prints join/leave lines with the watcher count", async () => {
    const { logs, restore } = captureLogs();
    try {
      const sock = await connectedShipper(0);

      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined", via: "v1" }) });
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined", via: "v2" }) });
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v1" }) });
      await new Promise((r) => setTimeout(r, 20));

      expect(presenceLines(logs)).toEqual([
        "  → viewer connected (1 watching)",
        "  → viewer connected (2 watching)",
        "  → viewer left (1 watching)",
      ]);
    } finally {
      restore();
    }
  });

  it("ignores a duplicate join notice without double-counting", async () => {
    const { logs, restore } = captureLogs();
    try {
      const sock = await connectedShipper(0);

      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined", via: "v1" }) });
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined", via: "v1" }) });
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v1" }) });
      await new Promise((r) => setTimeout(r, 20));

      expect(presenceLines(logs)).toEqual([
        "  → viewer connected (1 watching)",
        "  → viewer left (0 watching)",
      ]);
    } finally {
      restore();
    }
  });

  it("uses the relay's absolute count on leave and never decrements untracked vias", async () => {
    const { logs, restore } = captureLogs();
    try {
      // Two viewers were already attached when the shipper (re)connected:
      // their vias were never announced, so hello-ok carries the count.
      const sock = await connectedShipper(2);
      expect(logs.some((l) => l.includes("2 viewers already watching"))).toBe(true);

      // The relay's absolute count on leave is authoritative: a leave for
      // an unattributed via sets the count instead of decrementing a
      // snapshot the departing viewer may not have been part of (e.g. a
      // stale viewer reaped after a shipper reconnect).
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v-old", viewers: 1 }) });
      // Without an absolute count, a leave for an unknown via leaves the
      // count alone — it must never drive the display negative or steal a
      // healthy viewer's slot.
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v-ghost" }) });
      // A fresh join takes the relay's absolute count.
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined", via: "v-new", viewers: 2 }) });
      await new Promise((r) => setTimeout(r, 20));

      expect(presenceLines(logs)).toEqual([
        "  → viewer left (1 watching)",
        "  → viewer left (1 watching)",
        "  → viewer connected (2 watching)",
      ]);
    } finally {
      restore();
    }
  });

  it("clears count authority when a reconnect ack omits the snapshot", async () => {
    const { logs, restore } = captureLogs();
    try {
      // The shipper first talked to a current relay (authoritative count),
      // then reconnected after a relay rollback: the new hello-ok carries
      // no viewers, so the old count must not survive the epoch change.
      const sock = await connectedShipper(2);
      expect(logs.some((l) => l.includes("2 viewers already watching"))).toBe(true);

      sock.onmessage!({ data: JSON.stringify({ t: "hello-ok" }) });
      await new Promise((r) => setTimeout(r, 20));

      // A legacy leave after the rollback reports the disconnect without
      // resurrecting the stale "2 watching" count.
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v1" }) });
      await new Promise((r) => setTimeout(r, 20));

      expect(presenceLines(logs)).toEqual(["  → viewer left"]);
      expect(logs.some((l) => l.includes("2 watching"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("never fabricates a count for a legacy relay that omits it", async () => {
    const { logs, restore } = captureLogs();
    try {
      // A legacy relay omits `viewers` on hello-ok and only ever sends
      // viewer-left (never viewer-joined). With no authoritative count
      // and no tracked join, the leave is reported without inventing
      // "0 watching" — other viewers may still be attached.
      const sock = await connectedShipper();

      sock.onmessage!({ data: JSON.stringify({ t: "viewer-left", via: "v1" }) });
      await new Promise((r) => setTimeout(r, 20));

      expect(logs.some((l) => l.includes("already watching"))).toBe(false);
      expect(logs.some((l) => l.includes("watching"))).toBe(false);
      expect(presenceLines(logs)).toEqual(["  → viewer left"]);
    } finally {
      restore();
    }
  });

  it("ignores malformed/unknown control frames without dropping the connection", async () => {
    const { logs, restore } = captureLogs();
    try {
      const sock = await connectedShipper(0);

      // No `via`: must not print, must not throw, must not close.
      sock.onmessage!({ data: JSON.stringify({ t: "viewer-joined" }) });
      sock.onmessage!({ data: JSON.stringify({ t: "some-future-control", x: 1 }) });
      await new Promise((r) => setTimeout(r, 20));
      expect(presenceLines(logs)).toEqual([]);

      // The connection still works: a ping gets a routed response.
      sock.onmessage!({
        data: JSON.stringify({
          t: "frame",
          iv: "mock-iv",
          data: JSON.stringify({ seq: 42, cmd: "ping" }),
        }),
      });
      await waitFor(() => sock.sent.length > 1, "ping answered after unknown frames");
      expect(JSON.parse(lastOuter(sock).data as string)).toMatchObject({ seq: 42, ok: true });
    } finally {
      restore();
    }
  });
});
