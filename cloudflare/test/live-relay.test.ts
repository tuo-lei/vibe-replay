import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(notices).toContainEqual({ t: "viewer-left", via: a.vid });
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
    expect(notices).toContainEqual({ t: "viewer-left", via: b.vid });

    // A viewer remains, so the alarm stays armed.
    expect(h.alarmAt()).toBeGreaterThan(Date.now());
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

  function makeStorageRelay(): StorageHarness {
    const sockets: MockSocket[] = [];
    const store = new Map<string, unknown>();
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

  it("serves the box liveness probe: unknown / live / ended", async () => {
    const h = makeStorageRelay();
    const probe = () =>
      h.relay
        .fetch(new Request("https://relay.test/live/x2KJPqQxznNNftBLSHV5jA/status"))
        .then((r) => r.json() as Promise<{ status: string }>);

    // Box never existed.
    expect(await probe()).toEqual({ status: "unknown" });

    // Shipper attached.
    const { ws: vm, p } = helloVm(h);
    await p;
    expect(await probe()).toEqual({ status: "live" });

    // Shipper said goodbye.
    await h.relay.webSocketMessage(
      vm as unknown as WebSocket,
      JSON.stringify({ t: "goodbye", role: "vm" }),
    );
    expect(await probe()).toEqual({ status: "ended" });
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
