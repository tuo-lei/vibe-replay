import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRelay, __setNeverSeenWaitMs } from "../src/live-relay";

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
  return {
    ws,
    p: h.relay.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ t: "hello", role: "vm" }),
    ),
  };
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

function presenceFrames(
  ws: MockSocket,
): Array<{ viewers: Array<{ vid: string; name: { iv: string; data: string } | null }> }> {
  return ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "presence");
}

function lastPresence(ws: MockSocket) {
  const frames = presenceFrames(ws);
  return frames[frames.length - 1];
}

/** Fake encrypted display names (base64url `{iv, data}` — the relay can't read them). */
const LEI_CIPHER = { iv: "bGVpLWl2", data: "bGVpLWRhdGE" };
const WENDY_CIPHER = { iv: "d2VuZHktaXY", data: "d2VuZHktZGF0YQ" };

describe("LiveRelay multi-viewer", () => {
  it("lets two viewers watch the same box without displacing each other", async () => {
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    expect(a.ws.closed).toEqual([]);
    expect(b.ws.closed).toEqual([]);
    expect(a.vid).not.toBe(b.vid);

    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toHaveLength(2);
    expect(roster).toContainEqual({ vid: a.vid, name: LEI_CIPHER });
    expect(roster).toContainEqual({ vid: b.vid, name: WENDY_CIPHER });
    // The late joiner sees the full roster too.
    expect(lastPresence(b.ws)?.viewers).toHaveLength(2);
  });

  it("routes VM responses back to the requesting viewer only", async () => {
    const h = makeRelay();
    const { ws: vm } = helloVm(h);
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // A viewer frame is tagged with the sender's vid on the way to the VM.
    // (The vm socket also got its hello-ok ack — filter to routed frames.)
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i1", data: "d1" }),
    );
    const toVm = vm.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "frame");
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
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

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
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // Simulate the runtime removing the closed socket, then the close event.
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);

    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toEqual([{ vid: a.vid, name: LEI_CIPHER }]);
  });

  it("excludes the closing socket when the runtime still lists it on webSocketClose", async () => {
    // Production behavior (observed 2026-09-20): the closing socket is
    // still in getWebSockets() when webSocketClose fires — it even
    // receives the broadcast — and its lastSeen is fresh, so the 45 s
    // presence filter would not drop it. Without an explicit exclusion
    // the survivor's roster never shrinks on a clean leave.
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // b's socket is NOT removed: the close event fires first.
    const bPresenceBefore = presenceFrames(b.ws).length;
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);

    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toEqual([{ vid: a.vid, name: LEI_CIPHER }]);
    // The closing socket must not receive the shrunken roster either.
    expect(presenceFrames(b.ws)).toHaveLength(bPresenceBefore);
  });

  it("tells the shipper which viewer left so it can drop their tails", async () => {
    const h = makeRelay();
    const { ws: vm } = helloVm(h);
    const a = await helloViewer(h, LEI_CIPHER);
    await helloViewer(h, WENDY_CIPHER);

    h.sockets.splice(h.sockets.indexOf(a.ws), 1);
    await h.relay.webSocketClose(a.ws as unknown as WebSocket);

    const notices = vm.sent.map((s) => JSON.parse(s));
    // a is gone; b remains — the absolute count excludes the closing socket.
    expect(notices).toContainEqual({ t: "viewer-left", via: a.vid, viewers: 1 });
  });

  it("forwards encrypted display names verbatim and never sees plaintext", async () => {
    const h = makeRelay();
    helloVm(h);
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // The relay only ever handles ciphertext: the pretend plaintext behind
    // these ciphers ("Lei"/"Wendy") must appear nowhere in anything the
    // relay sent or stored.
    const allSent = [...a.ws.sent, ...b.ws.sent].join("\n");
    expect(allSent).not.toContain("Lei");
    expect(allSent).not.toContain("Wendy");
    expect(JSON.stringify(a.ws.attachment)).not.toContain("Lei");

    const roster = lastPresence(a.ws)?.viewers ?? [];
    expect(roster).toContainEqual({ vid: a.vid, name: LEI_CIPHER });
    expect(roster).toContainEqual({ vid: b.vid, name: WENDY_CIPHER });
  });

  it("degrades malformed name ciphertext to null (viewers render Guest)", async () => {
    const h = makeRelay();
    helloVm(h);
    const bad: unknown[] = [
      "Lei", // legacy plaintext is no longer accepted
      undefined, // missing
      { iv: "aXY" }, // missing data
      { data: "aXY" }, // missing iv
      { iv: "", data: "aXY" }, // empty iv
      { iv: "aXY", data: "!!!" }, // non-base64url chars
      { iv: "aXY", data: "z".repeat(3000) }, // absurd length
    ];
    const vids: string[] = [];
    for (const name of bad) vids.push((await helloViewer(h, name)).vid);

    const roster = lastPresence(h.sockets[h.sockets.length - 1])?.viewers ?? [];
    const byVid = new Map(roster.map((v) => [v.vid, v.name]));
    expect(roster).toHaveLength(bad.length);
    for (const vid of vids) expect(byVid.get(vid)).toBeNull();
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
    const a = await helloViewer(h, LEI_CIPHER);
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "i", data: "d" }),
    );
    // No VM: nothing to forward to, viewer stays connected for a later retry.
    expect(a.ws.closed).toEqual([]);
  });
});

/**
 * Shipper presence notices: the relay tells the shipper socket when viewers
 * join/leave (and how many are attached at hello-ok) so the CLI operator
 * can see who is watching. Routing metadata only — the shipper never sees
 * names.
 */
describe("LiveRelay shipper presence notices", () => {
  const controlNotices = (ws: MockSocket) =>
    ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.t === "viewer-joined" || m.t === "viewer-left");

  it("notifies the shipper when a viewer joins", async () => {
    const h = makeRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    expect(controlNotices(vm)).toEqual([
      { t: "viewer-joined", via: a.vid, viewers: 1 },
      { t: "viewer-joined", via: b.vid, viewers: 2 },
    ]);
  });

  it("sends no join notice when no shipper is attached (and does not crash)", async () => {
    const h = makeRelay();
    // No shipper hello: the viewer still gets a welcome; the shipper will
    // learn the count from its hello-ok when it (re)connects.
    const a = await helloViewer(h, LEI_CIPHER);
    expect(a.ws.closed).toEqual([]);

    const { ws: vm, p } = helloVm(h);
    await p;
    // No retroactive join notices — but the ack carries the live count.
    expect(controlNotices(vm)).toEqual([]);
    const acks = vm.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "hello-ok");
    expect(acks).toEqual([{ t: "hello-ok", viewers: 1 }]);
  });

  it("includes the live viewer count in the shipper's hello-ok", async () => {
    const h = makeRelay();
    const first = helloVm(h);
    await first.p;
    const firstAcks = first.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "hello-ok");
    expect(firstAcks).toEqual([{ t: "hello-ok", viewers: 0 }]);

    await helloViewer(h, LEI_CIPHER);
    await helloViewer(h, WENDY_CIPHER);

    // Shipper reconnects and displaces the first: the ack carries the live
    // roster count so the CLI can resync its watcher display.
    const second = helloVm(h);
    await second.p;
    expect(first.ws.closed).toEqual([{ code: 1000, reason: "replaced" }]);
    const secondAcks = second.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "hello-ok");
    expect(secondAcks).toEqual([{ t: "hello-ok", viewers: 2 }]);
  });

  it("routes join notices to the new shipper during takeover, not the closing socket", async () => {
    const h = makeRelay();
    const first = helloVm(h);
    await first.p;
    // A replacement shipper takes over: the old socket is closed...
    const second = helloVm(h);
    await second.p;
    expect(first.ws.closed).toEqual([{ code: 1000, reason: "replaced" }]);
    // ...but the runtime may still list it (the mock never removes
    // sockets, mirroring production's close-completion window).
    expect(h.sockets).toContain(first.ws);

    // A viewer joining in that window must notify the NEW shipper — the
    // dying socket must not swallow the join and leave the replacement
    // with a stale count from its earlier hello-ok snapshot.
    const v = await helloViewer(h, LEI_CIPHER);
    expect(controlNotices(first.ws)).toEqual([]);
    expect(controlNotices(second.ws)).toEqual([{ t: "viewer-joined", via: v.vid, viewers: 1 }]);
  });

  it("sends viewer-left on close so join/leave notices stay symmetric", async () => {
    const h = makeRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);

    h.sockets.splice(h.sockets.indexOf(a.ws), 1);
    await h.relay.webSocketClose(a.ws as unknown as WebSocket);

    expect(controlNotices(vm)).toEqual([
      { t: "viewer-joined", via: a.vid, viewers: 1 },
      { t: "viewer-left", via: a.vid, viewers: 0 },
    ]);
  });

  it("reports the absolute remaining count when a stale viewer is swept", async () => {
    const h = makeRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // b goes stale (> 45 s without a heartbeat): it drops out of the
    // presence-filtered roster while its socket is still attached.
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    // The sweep closes the stale socket; the runtime delivers the close.
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);

    // The leave notice carries the absolute remaining count (just a) — a
    // shipper that resynced from a hello-ok snapshot excluding stale b
    // must not decrement anything on this notice.
    expect(controlNotices(vm)).toEqual([
      { t: "viewer-joined", via: a.vid, viewers: 1 },
      { t: "viewer-joined", via: b.vid, viewers: 2 },
      { t: "viewer-left", via: b.vid, viewers: 1 },
    ]);
  });

  it("treats a heartbeat after staleness as a rejoin so a resynced shipper stops undercounting", async () => {
    const h = makeRelay();
    const first = helloVm(h);
    await first.p;
    const a = await helloViewer(h, LEI_CIPHER);

    // a goes stale (> 45 s without a heartbeat) while its socket stays open.
    (a.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    // Shipper reconnects mid-staleness: the hello-ok snapshot excludes a.
    const second = helloVm(h);
    await second.p;
    const acks = second.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "hello-ok");
    expect(acks).toEqual([{ t: "hello-ok", viewers: 0 }]);

    // a resumes heartbeating before the sweep reaps it: the relay notifies
    // the new shipper — a rejoin carrying the absolute count — so the CLI
    // repairs its undercount instead of showing 0 until the next unrelated
    // viewer transition.
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "heartbeat" }),
    );
    expect(controlNotices(second.ws)).toEqual([{ t: "viewer-joined", via: a.vid, viewers: 1 }]);
  });

  it("a revived viewer re-notifies a continuously connected shipper without double counting", async () => {
    const h = makeRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    (a.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "heartbeat" }),
    );

    // The relay still emits the rejoin notice — it cannot tell a resynced
    // shipper from a continuously connected one — but the absolute count
    // stays 1 and the CLI dedupes by vid, so no duplicate print or drift.
    expect(controlNotices(vm)).toEqual([
      { t: "viewer-joined", via: a.vid, viewers: 1 },
      { t: "viewer-joined", via: a.vid, viewers: 1 },
    ]);
  });

  it("never leaks plaintext names into shipper notices", async () => {
    const h = makeRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    await helloViewer(h, LEI_CIPHER);
    await helloViewer(h, WENDY_CIPHER);

    expect(vm.sent.join("\n")).not.toContain("Lei");
    expect(vm.sent.join("\n")).not.toContain("Wendy");
  });
});

/**
 * Presence liveness: close frames are not reliably delivered (proxies,
 * mobile radios, tab kills), so the relay sweeps sockets that stop proving
 * liveness instead of letting them accumulate as roster ghosts.
 */
describe("LiveRelay presence liveness sweep", () => {
  interface AlarmHarness extends Harness {
    alarmAt: () => number | null;
  }

  function makeAlarmRelay(): AlarmHarness {
    const sockets: MockSocket[] = [];
    let alarmAt: number | null = null;
    const ctx = {
      getWebSockets: () => [...sockets],
      acceptWebSocket: (ws: MockSocket) => {
        sockets.push(ws);
      },
      storage: {
        setAlarm: (at: number) => {
          alarmAt = at;
          return Promise.resolve();
        },
        getAlarm: () => Promise.resolve(alarmAt),
        deleteAlarm: () => {
          alarmAt = null;
          return Promise.resolve();
        },
      },
    } as unknown as DurableObjectState;
    return { relay: new LiveRelay(ctx), sockets, alarmAt: () => alarmAt };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms the sweep alarm on hello", async () => {
    const h = makeAlarmRelay();
    expect(h.alarmAt()).toBeNull();
    await helloViewer(h, LEI_CIPHER);
    expect(h.alarmAt()).toBeGreaterThan(Date.now());
  });

  it("sweeps viewers that stop heartbeating; heartbeating viewers survive", async () => {
    const h = makeAlarmRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // a proves liveness; b goes silent for over the 45 s viewer timeout.
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "heartbeat" }),
    );
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    await h.relay.alarm();
    expect(b.ws.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
    expect(a.ws.closed).toEqual([]);
    expect(vm.closed).toEqual([]);

    // The runtime delivers the close: the roster shrinks to the survivor and
    // the shipper is told to drop the dead viewer's tails.
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);
    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toEqual([{ vid: a.vid, name: LEI_CIPHER }]);
    const notices = vm.sent.map((s) => JSON.parse(s));
    // The swept viewer was already stale-excluded from the roster, so the
    // absolute remaining count is just the survivor — never negative drift.
    expect(notices).toContainEqual({ t: "viewer-left", via: b.vid, viewers: 1 });

    // A viewer remains, so the alarm stays armed.
    expect(h.alarmAt()).toBeGreaterThan(Date.now());
  });

  it("notifies the shipper during the sweep and does not double-notify on close", async () => {
    const h = makeAlarmRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);
    // b goes stale (> 45 s without a heartbeat) on a half-open socket.
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;
    const leaves = (ws: MockSocket) =>
      ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "viewer-left");

    // The sweep reaps the stale socket: the shipper learns the leave
    // immediately with the absolute remaining count, even though the
    // runtime hasn't delivered webSocketClose yet.
    await h.relay.alarm();
    expect(b.ws.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
    expect(leaves(vm)).toEqual([{ t: "viewer-left", via: b.vid, viewers: 1 }]);

    // When the runtime eventually delivers the close, no duplicate notice.
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);
    expect(leaves(vm)).toEqual([{ t: "viewer-left", via: b.vid, viewers: 1 }]);
  });

  it("does not re-notify the shipper on later sweeps while the half-open socket lingers", async () => {
    const h = makeAlarmRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;
    const leaves = (ws: MockSocket) =>
      ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "viewer-left");

    await h.relay.alarm();
    expect(leaves(vm)).toHaveLength(1);

    // The half-open socket is still listed across later alarms (the exact
    // delayed-close case): no repeated viewer-left, no rerun tail cleanup.
    await h.relay.alarm();
    await h.relay.alarm();
    expect(leaves(vm)).toHaveLength(1);
  });

  it("retries the sweep leave notice when no shipper was attached", async () => {
    const h = makeAlarmRelay();
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    // No shipper attached: the sweep reaps the socket but cannot notify —
    // and must not mark it notified, or the notice would be lost forever.
    await h.relay.alarm();
    expect(b.ws.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
    expect((b.ws.attachment as { leaveNotified?: boolean }).leaveNotified).toBeUndefined();

    // A shipper attaches before the delayed close: the close callback still
    // delivers the leave, so the CLI drops the dead viewer's tails.
    const { ws: vm, p } = helloVm(h);
    await p;
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);
    const leaves = vm.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "viewer-left");
    expect(leaves).toEqual([{ t: "viewer-left", via: b.vid, viewers: 1 }]);
  });

  it("keeps the sweep leave notice retryable when the shipper's send fails", async () => {
    const h = makeAlarmRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    // The shipper's socket dies mid-send: the notice is lost, and the flag
    // must stay clear so a replacement shipper can still learn the leave.
    const origSend = vm.send;
    vm.send = () => {
      throw new Error("boom");
    };
    await h.relay.alarm();
    expect((b.ws.attachment as { leaveNotified?: boolean }).leaveNotified).toBeUndefined();
    vm.send = origSend;

    // A replacement shipper connects; the delayed close retries the notice.
    const second = helloVm(h);
    await second.p;
    h.sockets.splice(h.sockets.indexOf(b.ws), 1);
    await h.relay.webSocketClose(b.ws as unknown as WebSocket);
    const leaves = second.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "viewer-left");
    expect(leaves).toEqual([{ t: "viewer-left", via: b.vid, viewers: 1 }]);
  });

  it("broadcasts the shrunken roster immediately after the sweep, before webSocketClose", async () => {
    const h = makeAlarmRelay();
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    // b goes silent for over the 45 s viewer timeout.
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;
    // Clear sent buffers so we only see what the alarm broadcasts.
    a.ws.sent.length = 0;
    b.ws.sent.length = 0;

    await h.relay.alarm();
    expect(b.ws.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);

    // The sweep reaps b but the runtime hasn't delivered webSocketClose yet
    // (b.ws is still in getWebSockets). The alarm must have pushed a roster
    // that already excludes the ghost, via the viewers() staleness filter.
    const roster = lastPresence(a.ws)?.viewers;
    expect(roster).toEqual([{ vid: a.vid, name: LEI_CIPHER }]);
  });

  it("migrates legacy attachments without lastSeen, then sweeps them if they stay silent", async () => {
    const h = makeAlarmRelay();
    const a = await helloViewer(h, LEI_CIPHER);
    // Simulate a socket attached before the liveness sweep deployed.
    delete (a.ws.attachment as { lastSeen?: number }).lastSeen;

    // First alarm: grace period — stamped with lastSeen, not swept.
    await h.relay.alarm();
    expect(a.ws.closed).toEqual([]);
    expect(typeof (a.ws.attachment as { lastSeen?: number }).lastSeen).toBe("number");

    // Still silent past the 45 s viewer timeout → swept on a later pass.
    (a.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;
    await h.relay.alarm();
    expect(a.ws.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
  });

  it("disarms the alarm once the last socket is gone", async () => {
    const h = makeAlarmRelay();
    const a = await helloViewer(h, LEI_CIPHER);
    expect(h.alarmAt()).not.toBeNull();
    h.sockets.splice(h.sockets.indexOf(a.ws), 1);
    await h.relay.webSocketClose(a.ws as unknown as WebSocket);
    expect(h.alarmAt()).toBeNull();
  });

  it("rejects heartbeats from sockets that never said hello", async () => {
    const h = makeAlarmRelay();
    const ws = mockSocket();
    h.sockets.push(ws);
    await h.relay.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ t: "heartbeat" }));
    expect(ws.closed).toEqual([{ code: 1003, reason: "hello first" }]);
  });

  it("reaps a shipper whose keepalives stopped; live keepalives refresh it", async () => {
    const h = makeAlarmRelay();
    const { ws: vm, p } = helloVm(h);
    await p;

    // A keepalive no-op frame proves the shipper is alive.
    (vm.attachment as { lastSeen: number }).lastSeen -= 100_000;
    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "k", data: "x" }),
    );
    await h.relay.alarm();
    expect(vm.closed).toEqual([]);

    // Silent past the VM timeout (shipper keepalive is every 45 s) → swept.
    (vm.attachment as { lastSeen: number }).lastSeen -= 200_000;
    await h.relay.alarm();
    expect(vm.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
  });
});

/**
 * Box lifecycle: a clean shipper goodbye — or a shipper gone past the end
 * grace — declares the box permanently dead. Late joiners and the /status
 * probe learn it instantly instead of hanging on "Connecting…". The relay
 * still only persists the lifecycle flag; session content stays opaque.
 */
describe("LiveRelay box lifecycle (session ended)", () => {
  interface StorageHarness extends Harness {
    alarmAt: () => number | null;
    store: Map<string, unknown>;
  }

  function makeStorageRelay(existingStore?: Map<string, unknown>): StorageHarness {
    const sockets: MockSocket[] = [];
    const store = existingStore ?? new Map<string, unknown>();
    let alarmAt: number | null = null;
    const ctx = {
      getWebSockets: () => [...sockets],
      acceptWebSocket: (ws: MockSocket) => {
        sockets.push(ws);
      },
      storage: {
        get: (k: string) => Promise.resolve(store.get(k)),
        put: (k: string, v: unknown) => {
          store.set(k, v);
          return Promise.resolve();
        },
        delete: (k: string) => {
          store.delete(k);
          return Promise.resolve();
        },
        setAlarm: (at: number) => {
          alarmAt = at;
          return Promise.resolve();
        },
        getAlarm: () => Promise.resolve(alarmAt),
        deleteAlarm: () => {
          alarmAt = null;
          return Promise.resolve();
        },
      },
    } as unknown as DurableObjectState;
    return { relay: new LiveRelay(ctx), sockets, alarmAt: () => alarmAt, store };
  }

  const sessionEndedFrames = (ws: MockSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "session-ended");

  it("a clean shipper goodbye ends the box immediately for attached viewers", async () => {
    const h = makeStorageRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);

    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "vm" }),
    );

    expect(h.store.get("ended")).toBe(true);
    for (const v of [a, b]) {
      expect(sessionEndedFrames(v.ws)).toHaveLength(1);
      expect(v.ws.closed).toEqual([{ code: 1000, reason: "session ended" }]);
    }
    // No plaintext leaked into anything the relay sent or stored.
    const allSent = [...a.ws.sent, ...b.ws.sent].join("\n");
    expect(allSent).not.toContain("Lei");
    expect(allSent).not.toContain("Wendy");
  });

  it("a viewer joining a dead box learns it immediately, with no welcome", async () => {
    const h = makeStorageRelay();
    h.store.set("ended", true);
    const ws = mockSocket();
    h.sockets.push(ws);
    await h.relay.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ t: "hello", role: "viewer", name: LEI_CIPHER }),
    );
    expect(sessionEndedFrames(ws)).toHaveLength(1);
    expect(ws.closed).toEqual([{ code: 1000, reason: "session ended" }]);
    expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.t === "welcome")).toBe(false);
  });

  it("a shipper helloing for an ended box is told to exit, not revived", async () => {
    const h = makeStorageRelay();
    h.store.set("ended", true);
    const { ws, p } = helloVm(h);
    await p;
    expect(sessionEndedFrames(ws)).toHaveLength(1);
    expect(ws.closed).toEqual([{ code: 1000, reason: "box ended" }]);
    // The box stays ended — the zombie hello must not clear it.
    expect(h.store.get("ended")).toBe(true);
    // …and a zombie gets no hello-ok: the CLI must not print a URL for it.
    expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.t === "hello-ok")).toBe(false);
  });

  it("acks a shipper hello once the claim landed", async () => {
    const h = makeStorageRelay();
    const { ws, p } = helloVm(h);
    await p;
    // The CLI prints the share URL only after this ack, so no viewer can
    // open the URL before the relay knows the shipper.
    expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.t === "hello-ok")).toBe(true);
  });

  it("a goodbye from a viewer never ends the box", async () => {
    const h = makeStorageRelay();
    const { p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "viewer" }),
    );
    expect(h.store.get("ended")).toBeUndefined();
  });

  it("an unclean shipper death starts the end grace; a quick reconnect saves the box", async () => {
    const h = makeStorageRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);

    // Shipper socket dies without goodbye: grace starts, box not ended.
    h.sockets.splice(h.sockets.indexOf(vm), 1);
    await h.relay.webSocketClose(vm as unknown as WebSocket);
    expect(typeof h.store.get("vmGoneAt")).toBe("number");
    expect(h.store.get("ended")).toBeUndefined();

    // Sweep inside the grace: nobody is told the session ended.
    await h.relay.alarm();
    expect(h.store.get("ended")).toBeUndefined();
    expect(sessionEndedFrames(a.ws)).toHaveLength(0);
    expect(a.ws.closed).toEqual([]);

    // Shipper reconnects inside the grace (same box id): grace cancelled.
    const { p: p2 } = helloVm(h);
    await p2;
    expect(h.store.get("vmGoneAt")).toBeUndefined();
    await h.relay.alarm();
    expect(h.store.get("ended")).toBeUndefined();
    expect(a.ws.closed).toEqual([]);
  });

  it("a displaced shipper's close does not start the box-end grace", async () => {
    const h = makeStorageRelay();
    const first = helloVm(h);
    await first.p;
    // Takeover: the old socket is marked displaced and closed...
    const second = helloVm(h);
    await second.p;
    expect(first.ws.closed).toEqual([{ code: 1000, reason: "replaced" }]);
    expect(second.ws.closed).toEqual([]);

    // ...but the runtime may still list it when its close event fires.
    // That close must not start the end grace — the replacement is
    // already connected.
    await h.relay.webSocketClose(first.ws as unknown as WebSocket);
    expect(h.store.get("vmGoneAt")).toBeUndefined();
    expect(h.store.get("ended")).toBeUndefined();
  });

  it("the box ends when the grace expires with no reconnect", async () => {
    const h = makeStorageRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);

    h.sockets.splice(h.sockets.indexOf(vm), 1);
    await h.relay.webSocketClose(vm as unknown as WebSocket);
    // Fast-forward past the grace (90 s).
    h.store.set("vmGoneAt", Date.now() - 120_000);

    await h.relay.alarm();
    expect(h.store.get("ended")).toBe(true);
    expect(sessionEndedFrames(a.ws)).toHaveLength(1);
    expect(a.ws.closed).toEqual([{ code: 1000, reason: "session ended" }]);
    // The sweep disarms once the box is dead and nobody is attached.
    h.sockets.splice(h.sockets.indexOf(a.ws), 1);
    await h.relay.webSocketClose(a.ws as unknown as WebSocket);
    expect(h.alarmAt()).toBeNull();
  });

  it("serves the box liveness probe: unknown / live / unknown / ended", async () => {
    const h = makeStorageRelay();
    const probe = () =>
      h.relay
        .fetch(new Request("https://relay.test/live/x2KJPqQxznNNftBLSHV5jA/status"))
        .then((r) => r.json() as Promise<{ status: string }>);

    // Box never had a shipper: "unknown", not "ended" — the probe stays
    // conservative (a shipper hello may still be on its way); the viewer
    // websocket gets the fast session-ended instead of hanging.
    expect(await probe()).toEqual({ status: "unknown" });

    // Shipper attached.
    const { ws: vm, p } = helloVm(h);
    await p;
    expect(await probe()).toEqual({ status: "live" });

    // Shipper lost uncleanly: inside the end grace it may still come back.
    await h.relay.webSocketClose(vm as unknown as WebSocket, 1006, "boom");
    h.sockets.splice(h.sockets.indexOf(vm), 1);
    expect(await probe()).toEqual({ status: "unknown" });

    // Shipper said goodbye: permanently dead.
    const { ws: vm2, p: p2 } = helloVm(h);
    await p2;
    await h.relay.webSocketMessage(
      vm2 as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "vm" }),
    );
    expect(await probe()).toEqual({ status: "ended" });
  });

  it("a viewer hello for a box that never had a shipper fails fast with session-ended", async () => {
    __setNeverSeenWaitMs(25);
    try {
      const h = makeStorageRelay();
      const ws = mockSocket();
      h.sockets.push(ws);
      await h.relay.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ t: "hello", role: "viewer", name: LEI_CIPHER }),
      );
      // No welcome, no hanging on "Connecting…" through the retry budget.
      expect(sessionEndedFrames(ws)).toHaveLength(1);
      expect(ws.closed).toEqual([{ code: 1000, reason: "box unknown" }]);
      expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.t === "welcome")).toBe(false);
    } finally {
      __setNeverSeenWaitMs(5000);
    }
  });

  it("a viewer hello waits briefly for a shipper hello that lands just after", async () => {
    // The race Codex flagged: the viewer must not conclude "box unknown"
    // while a shipper hello is still on its way (e.g. re-helloing after a
    // deploy evicted the DO).
    __setNeverSeenWaitMs(2000);
    try {
      const h = makeStorageRelay();
      const ws = mockSocket();
      h.sockets.push(ws);
      const viewerDone = h.relay.webSocketMessage(
        ws as unknown as WebSocket,
        JSON.stringify({ t: "hello", role: "viewer", name: LEI_CIPHER }),
      );
      // Let the viewer hello reach its wait, then land the shipper hello.
      await new Promise((r) => setTimeout(r, 100));
      const { p: vmDone } = helloVm(h);
      await vmDone;
      await viewerDone;
      expect(sessionEndedFrames(ws)).toHaveLength(0);
      expect(ws.closed).toEqual([]);
      expect(ws.sent.map((s) => JSON.parse(s)).some((m) => m.t === "welcome")).toBe(true);
    } finally {
      __setNeverSeenWaitMs(5000);
    }
  });

  it("a viewer joining inside the shipper-loss grace is not fast-ended", async () => {
    const h = makeStorageRelay();
    const { ws: vm, p } = helloVm(h);
    await p;
    // Unclean shipper loss: close without goodbye; the socket is gone the
    // way production removes it from getWebSockets().
    await h.relay.webSocketClose(vm as unknown as WebSocket, 1006, "boom");
    h.sockets.splice(h.sockets.indexOf(vm), 1);
    expect(h.store.get("vmSeen")).toBe(true);

    // The box may still come back — the viewer gets a normal welcome and
    // rides the reconnect path, never a false ended page.
    const v = await helloViewer(h, LEI_CIPHER);
    expect(sessionEndedFrames(v.ws)).toHaveLength(0);
    expect(v.ws.closed).toEqual([]);
  });

  it("a DO restart does not fast-end viewers before the shipper re-hellos", async () => {
    const h1 = makeStorageRelay();
    const { p } = helloVm(h1);
    await p;
    expect(h1.store.get("vmSeen")).toBe(true);

    // New DO instance, same durable storage, no sockets yet: this is what
    // a deploy restart looks like. vmSeen survived in storage.
    const h2 = makeStorageRelay(h1.store);
    const v = await helloViewer(h2, LEI_CIPHER);
    expect(sessionEndedFrames(v.ws)).toHaveLength(0);
    expect(v.ws.closed).toEqual([]);
  });

  it("non-status non-websocket fetches still get 426", async () => {
    const h = makeStorageRelay();
    const res = await h.relay.fetch(new Request("https://relay.test/live/x2KJPqQxznNNftBLSHV5jA"));
    expect(res.status).toBe(426);
  });
});

describe("LiveRelay box lifecycle — stale viewer sockets", () => {
  // Reuses the storage harness + sessionEndedFrames helper from the
  // lifecycle describe block above via closure-free duplication: the
  // helpers are block-scoped, so this block defines its own minimal ones.
  interface H {
    relay: LiveRelay;
    sockets: MockSocket[];
    store: Map<string, unknown>;
  }
  function makeHarness(): H {
    const sockets: MockSocket[] = [];
    const store = new Map<string, unknown>();
    const ctx = {
      getWebSockets: () => [...sockets],
      acceptWebSocket: (ws: MockSocket) => {
        sockets.push(ws);
      },
      storage: {
        get: (k: string) => Promise.resolve(store.get(k)),
        put: (k: string, v: unknown) => {
          store.set(k, v);
          return Promise.resolve();
        },
        delete: (k: string) => {
          store.delete(k);
          return Promise.resolve();
        },
        setAlarm: () => Promise.resolve(),
        getAlarm: () => Promise.resolve(null),
        deleteAlarm: () => Promise.resolve(),
      },
    } as unknown as DurableObjectState;
    return { relay: new LiveRelay(ctx), sockets, store };
  }
  const endedFrames = (ws: MockSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "session-ended");

  it("endBox reaches even a suspended viewer that missed heartbeats", async () => {
    const h = makeHarness();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    const b = await helloViewer(h, WENDY_CIPHER);
    // b is a suspended mobile tab: socket attached, heartbeats stale past
    // the 45 s presence filter, so the roster no longer lists it.
    (b.ws.attachment as { lastSeen: number }).lastSeen -= 60_000;

    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "vm" }),
    );

    // Both learn it — the stale socket is not silently left on a dead box.
    for (const v of [a, b]) {
      expect(endedFrames(v.ws)).toHaveLength(1);
      expect(v.ws.closed).toEqual([{ code: 1000, reason: "session ended" }]);
    }
  });

  it("a viewer message on an ended box is answered with session-ended, never a silent rejoin", async () => {
    const h = makeHarness();
    const { ws: vm, p } = helloVm(h);
    await p;
    const a = await helloViewer(h, LEI_CIPHER);
    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "vm" }),
    );
    expect(h.store.get("ended")).toBe(true);

    // The socket survived endBox half-open (the mock never removes it):
    // its next heartbeat must not refresh the sweep clock or rejoin the
    // dead box.
    a.ws.sent.length = 0;
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "heartbeat" }),
    );
    expect(endedFrames(a.ws)).toHaveLength(1);
    expect(a.ws.closed[a.ws.closed.length - 1]).toEqual({
      code: 1000,
      reason: "session ended",
    });

    // And a viewer command on the dead box is dropped, not routed.
    a.ws.sent.length = 0;
    await h.relay.webSocketMessage(
      a.ws as unknown as WebSocket,
      JSON.stringify({ t: "frame", iv: "x", data: "y" }),
    );
    expect(endedFrames(a.ws)).toHaveLength(1);
  });
});
