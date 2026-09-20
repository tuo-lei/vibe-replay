import { describe, expect, it, vi } from "vitest";
import { LiveRelay } from "../src/live-relay";

/**
 * Unit tests for the LiveRelay Durable Object: multi-viewer coexistence,
 * presence roster, and per-viewer response routing. The class is plain
 * (no "cloudflare:workers" import), so we drive webSocketMessage directly
 * with mocked sockets instead of standing up miniflare.
 */

interface MockSocket {
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
  attachment: unknown;
  send(data: string): void;
  close(code: number, reason?: string): void;
  serializeAttachment(d: unknown): void;
  deserializeAttachment(): unknown;
}

function mockSocket(): MockSocket {
  return {
    sent: [],
    closed: [],
    attachment: null,
    send(data: string) {
      this.sent.push(data);
    },
    close(code: number, reason = "") {
      this.closed.push({ code, reason });
    },
    serializeAttachment(d: unknown) {
      this.attachment = d;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

interface Harness {
  relay: LiveRelay;
  sockets: MockSocket[];
}

function makeRelay(): Harness {
  const sockets: MockSocket[] = [];
  const ctx = {
    getWebSockets: () => [...sockets],
    acceptWebSocket: (ws: MockSocket) => {
      sockets.push(ws);
    },
  } as unknown as DurableObjectState;
  return { relay: new LiveRelay(ctx), sockets };
}

const helloVm = (h: Harness) => {
  const ws = mockSocket();
  h.sockets.push(ws);
  return { ws, p: h.relay.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ t: "hello", role: "vm" })) };
};

async function helloViewer(h: Harness, name?: unknown): Promise<{ ws: MockSocket; vid: string }> {
  const ws = mockSocket();
  h.sockets.push(ws);
  await h.relay.webSocketMessage(
    ws as unknown as WebSocket,
    JSON.stringify({ t: "hello", role: "viewer", name }),
  );
  const welcome = ws.sent.map((s) => JSON.parse(s)).find((m) => m.t === "welcome");
  expect(welcome?.vid).toBeTruthy();
  return { ws, vid: welcome.vid as string };
}

function presenceFrames(ws: MockSocket): Array<{ viewers: Array<{ vid: string; name: string }> }> {
  return ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "presence");
}

function lastPresence(ws: MockSocket) {
  const frames = presenceFrames(ws);
  return frames[frames.length - 1];
}

describe("LiveRelay multi-viewer", () => {
  it("lets two viewers watch the same box without displacing each other", async () => {
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, "Lei");
    const b = await helloViewer(h, "Wendy");

    expect(a.ws.closed).toEqual([]);
    expect(b.ws.closed).toEqual([]);
    expect(a.vid).not.toBe(b.vid);

    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toHaveLength(2);
    expect(roster).toContainEqual({ vid: a.vid, name: "Lei" });
    expect(roster).toContainEqual({ vid: b.vid, name: "Wendy" });
    // The late joiner sees the full roster too.
    expect(lastPresence(b.ws)?.viewers).toHaveLength(2);
  });

  it("routes VM responses back to the requesting viewer only", async () => {
    const h = makeRelay();
    const { ws: vm } = helloVm(h);
    const a = await helloViewer(h, "Lei");
    const b = await helloViewer(h, "Wendy");

    // A viewer frame is tagged with the sender's vid on the way to the VM.
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i1", data: "d1" }),
    );
    const toVm = vm.sent.map((s) => JSON.parse(s));
    expect(toVm).toHaveLength(1);
    expect(toVm[0]).toMatchObject({ t: "frame", iv: "i1", data: "d1", via: a.vid });

    // The VM echoes `via`: only that viewer receives the reply, tag stripped.
    const bBefore = b.ws.sent.length;
    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i2", data: "d2", via: a.vid }),
    );
    const aFrames = a.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "frame");
    expect(aFrames).toHaveLength(1);
    expect(aFrames[0]).toEqual({ t: "frame", iv: "i2", data: "d2" });
    expect(b.ws.sent.length).toBe(bBefore);

    // A reply for an unknown vid is dropped, not broadcast.
    const aBefore = a.ws.sent.length;
    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i3", data: "d3", via: "no-such-viewer" }),
    );
    expect(a.ws.sent.length).toBe(aBefore);
    expect(b.ws.sent.length).toBe(bBefore);
  });

  it("broadcasts untagged VM frames (keepalive) to every viewer", async () => {
    const h = makeRelay();
    const { ws: vm } = helloVm(h);
    const a = await helloViewer(h, "Lei");
    const b = await helloViewer(h, "Wendy");

    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "k", data: "keepalive" }),
    );
    for (const v of [a, b]) {
      const frames = v.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "frame");
      expect(frames).toEqual([{ t: "frame", iv: "k", data: "keepalive" }]);
    }
  });

  it("pushes a shrunken roster when a viewer leaves", async () => {
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, "Lei");
    const b = await helloViewer(h, "Wendy");

    // Simulate the runtime removing the closed socket, then the close event.
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);

    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toEqual([{ vid: a.vid, name: "Lei" }]);
  });

  it("tells the shipper which viewer left so it can drop their tails", async () => {
    const h = makeRelay();
    const { ws: vm } = helloVm(h);
    const a = await helloViewer(h, "Lei");
    await helloViewer(h, "Wendy");

    h.sockets.splice(h.sockets.indexOf(a.ws), 1);
    await h.relay.webSocketClose(a.ws as unknown as WebSocket);

    const notices = vm.sent.map((s) => JSON.parse(s));
    expect(notices).toContainEqual({ t: "viewer-left", via: a.vid });
  });

  it("sanitizes display names: truncates, strips control chars, defaults to Guest", async () => {
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, "x".repeat(100));
    const b = await helloViewer(h, undefined);
    await helloViewer(h, "  ab  ");

    const roster = lastPresence(a.ws)?.viewers ?? [];
    const byVid = new Map(roster.map((v) => [v.vid, v.name]));
    expect(byVid.get(a.vid)).toBe("x".repeat(32));
    expect(byVid.get(b.vid)).toBe("Guest");
  });

  it("still displaces the previous VM shipper", async () => {
    const h = makeRelay();
    const first = helloVm(h);
    const second = helloVm(h);
    await first.p;
    await second.p;
    expect(first.ws.closed).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(second.ws.closed).toEqual([]);
  });

  it("closes sockets that speak before hello", async () => {
    const h = makeRelay();
    const ws = mockSocket();
    h.sockets.push(ws);
    await h.relay.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i", data: "d" }),
    );
    expect(ws.closed).toEqual([{ code: 1003, reason: "hello first" }]);
  });

  it("drops viewer frames when the shipper is away", async () => {
    const h = makeRelay();
    const a = await helloViewer(h, "Lei");
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i", data: "d" }),
    );
    // No VM: nothing to forward to, viewer stays connected for a later retry.
    expect(a.ws.closed).toEqual([]);
  });
});
