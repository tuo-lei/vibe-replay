import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/relay-crypto.js", () => ({
  decryptFrame: async (_key: unknown, _boxId: string, frame: { data: string }) => frame.data,
  encryptFrame: async (_key: unknown, _boxId: string, plaintext: string) => ({
    iv: "mock-iv",
    data: plaintext,
  }),
  exportKeyString: () => "k".repeat(43),
  generateContentKey: async () => ({ key: {}, raw: new Uint8Array(32) }),
  randomBoxId: () => "b".repeat(22),
}));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);

const { createRelayTransport } = await import("../src/relay-transport.js");

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.instances = [];
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("relay transport", () => {
  it("gates readiness on hello-ok and preserves viewer routing", async () => {
    const transport = await createRelayTransport({
      relayOrigin: "http://localhost:1",
      goodbyeFlushMs: 0,
      handleCommand: async (message) => ({ seq: message.seq, ok: true, data: "pong" }),
    });
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe(`ws://localhost:1/live/${"b".repeat(22)}`);

    socket.onopen?.();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ t: "hello", role: "vm" });

    let ready = false;
    void transport.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    socket.onmessage?.({ data: JSON.stringify({ t: "hello-ok", viewers: 0 }) } as MessageEvent);
    await transport.ready;

    socket.onmessage?.({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 7, cmd: "ping" }),
        via: "viewer-1",
      }),
    } as MessageEvent);
    await waitFor(() => socket.sent.length >= 2);
    const response = JSON.parse(socket.sent[1]!) as Record<string, unknown>;
    expect(response.via).toBe("viewer-1");
    expect(JSON.parse(response.data as string)).toMatchObject({ seq: 7, ok: true, data: "pong" });
    await transport.stop();
  });

  it("chunks large UTF-8 responses without tearing code points", async () => {
    const value = "中".repeat(1_500_000);
    const transport = await createRelayTransport({
      relayOrigin: "http://localhost:1",
      goodbyeFlushMs: 0,
      handleCommand: async (message) => ({ seq: message.seq, ok: true, data: value }),
    });
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ t: "hello-ok" }) } as MessageEvent);
    await transport.ready;
    socket.sent = [];

    socket.onmessage?.({
      data: JSON.stringify({
        t: "frame",
        iv: "mock-iv",
        data: JSON.stringify({ seq: 9, cmd: "large" }),
        via: "viewer-cjk",
      }),
    } as MessageEvent);
    await waitFor(() => socket.sent.length > 1);

    const frames = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames.every((frame) => frame.via === "viewer-cjk")).toBe(true);
    expect(
      frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8") < 4 * 1024 * 1024),
    ).toBe(true);
    const chunks = frames
      .map((frame) => JSON.parse(frame.data as string) as Record<string, unknown>)
      .sort((a, b) => (a.chunk as number) - (b.chunk as number));
    const reassembled = JSON.parse(chunks.map((chunk) => chunk.data as string).join("")) as {
      data: string;
    };
    expect(reassembled.data).toBe(value);
    await transport.stop();
  });

  it("sends goodbye before closing", async () => {
    const transport = await createRelayTransport({
      relayOrigin: "http://localhost:1",
      goodbyeFlushMs: 0,
      handleCommand: async () => ({ ok: true }),
    });
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ t: "hello-ok" }) } as MessageEvent);
    await transport.ready;

    await transport.stop();
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({ t: "goodbye", role: "vm" });
    expect(socket.close).toHaveBeenCalledWith(1000, "shutdown");
  });

  it("rejects readiness and closes the socket when startup times out", async () => {
    vi.useFakeTimers();
    const onPermanentEnd = vi.fn();
    const transport = await createRelayTransport({
      relayOrigin: "http://localhost:1",
      startupTimeoutMs: 100,
      goodbyeFlushMs: 0,
      handleCommand: async () => ({ ok: true }),
      onPermanentEnd,
    });
    const socket = FakeSocket.instances[0]!;

    const ready = expect(transport.ready).rejects.toThrow("did not become ready within 100ms");
    await vi.advanceTimersByTimeAsync(100);

    await ready;
    expect(socket.close).toHaveBeenCalledWith(1000, "box ended");
    expect(onPermanentEnd).toHaveBeenCalledTimes(1);
  });

  it("reconnects the same box after a transient close", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const transport = await createRelayTransport({
      relayOrigin: "http://localhost:1",
      goodbyeFlushMs: 0,
      handleCommand: async () => ({ ok: true }),
      onConnectionChange: (state) => states.push(state),
    });
    const first = FakeSocket.instances[0]!;
    first.onopen?.();
    first.onmessage?.({ data: JSON.stringify({ t: "hello-ok" }) } as MessageEvent);
    await transport.ready;

    first.onclose?.({ reason: "" } as CloseEvent);
    expect(states).toContain("retrying");
    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toBe(first.url);
    await transport.stop();
  });

  it("rejects cleartext non-loopback relay origins", async () => {
    await expect(
      createRelayTransport({
        relayOrigin: "http://relay.example.test",
        handleCommand: async () => ({ ok: true }),
      }),
    ).rejects.toThrow("refusing cleartext relay origin");
  });
});
