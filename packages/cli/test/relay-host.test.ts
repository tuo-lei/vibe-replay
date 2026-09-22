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
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = 3;
  });
  send = vi.fn();

  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
}

vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);

const { createRelayHost, RELAY_STARTUP_TIMEOUT_MS } = await import("../src/relay-host.js");

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.instances = [];
});

describe("createRelayHost readiness", () => {
  it("rejects readiness and closes the socket when startup times out", async () => {
    vi.useFakeTimers();
    const onPermanentEnd = vi.fn();
    const host = await createRelayHost({
      relayOrigin: "http://localhost:1",
      handleCommand: async () => ({ ok: true }),
      onPermanentEnd,
    });
    const socket = FakeSocket.instances[0]!;

    const readyExpectation = expect(host.ready).rejects.toThrow("did not become ready");
    await vi.advanceTimersByTimeAsync(RELAY_STARTUP_TIMEOUT_MS);

    await readyExpectation;
    expect(socket.close).toHaveBeenCalled();
    expect(onPermanentEnd).toHaveBeenCalledTimes(1);
  });

  it("tracks encrypted viewer presence for the local host", async () => {
    const onPresenceChange = vi.fn();
    const host = await createRelayHost({
      relayOrigin: "http://localhost:1",
      handleCommand: async () => ({ ok: true }),
      onPresenceChange,
    });
    const socket = FakeSocket.instances[0]!;
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        t: "hello-ok",
        viewers: 1,
        presence: [{ vid: "viewer-1", name: { iv: "iv", data: "Blue Otter" } }],
      }),
    } as MessageEvent);
    await host.ready;
    await vi.waitFor(() =>
      expect(host.viewers()).toEqual([{ id: "viewer-1", name: "Blue Otter" }]),
    );

    socket.onmessage?.({
      data: JSON.stringify({
        t: "viewer-joined",
        via: "viewer-2",
        viewers: 2,
        name: { iv: "iv", data: "Wendy" },
      }),
    } as MessageEvent);
    await vi.waitFor(() => expect(host.viewers()).toHaveLength(2));

    socket.onmessage?.({
      data: JSON.stringify({ t: "viewer-left", via: "viewer-1", viewers: 1 }),
    } as MessageEvent);
    await vi.waitFor(() => expect(host.viewers()).toEqual([{ id: "viewer-2", name: "Wendy" }]));
    expect(onPresenceChange).toHaveBeenCalled();
    await host.stop();
  });
});
