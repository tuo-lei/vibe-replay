/**
 * LiveRelay — the dumb pipe for `vibe-replay relay`.
 *
 * One Durable Object instance per box id (`live:<boxId>`). It holds the VM
 * shipper socket (`role: "vm"`) and any number of viewer sockets (`role:
 * "viewer"`), and forwards opaque `{t:"frame", iv, data}` envelopes between
 * them verbatim.
 *
 * The relay NEVER sees plaintext: every command/response payload is
 * AES-256-GCM encrypted end-to-end between the VM and the viewer with a key
 * that lives only in the share URL fragment. This mirrors excalidraw-room,
 * whose socket handler forwards `encryptedData` without decrypting it.
 *
 * Two pieces of routing metadata ARE relay-visible (plaintext), exactly like
 * Excalidraw's room id:
 * - `via`: the relay tags each viewer→VM frame with the sender's viewer id;
 *   the shipper echoes it back on its response so the relay can route the
 *   reply to the right viewer. Frames from the VM without `via` (the
 *   shipper's keepalive no-ops) are broadcast to all viewers.
 * - presence: each viewer announces its display name AES-GCM-encrypted with
 *   the share URL fragment key (the same key as the command frames) in its
 *   hello; the relay stores and broadcasts the ciphertext verbatim and can
 *   never see the plaintext. Viewers decrypt names locally with the fragment
 *   key.
 *
 * Uses the Hibernation API, so an idle box (VM holding its socket open with
 * nobody watching) costs ~zero duration billing: the runtime answers
 * ping/pong without waking the object.
 *
 * Liveness: viewers send a plaintext `{t:"heartbeat"}` every
 * HEARTBEAT_INTERVAL_MS; a periodic alarm sweeps sockets silent past the
 * timeout (viewers 45 s, shipper 150 s). Close frames are not reliably
 * delivered through proxies and mobile radios, so without the sweep dead
 * viewers would accumulate as roster ghosts.
 *
 * Note: this class deliberately does NOT import from "cloudflare:workers".
 * A plain class with the right shape works as a Durable Object, and it keeps
 * the module importable in plain vitest runs (which can't resolve the
 * runtime-only module).
 */

type Role = "vm" | "viewer";

/**
 * Encrypted display name carried in a viewer's hello and in presence
 * broadcasts. AES-GCM ciphertext (`{iv, data}`, base64url) produced in the
 * browser with the share URL fragment key — opaque to the relay.
 */
export interface NameCipher {
  iv: string;
  data: string;
}

interface Attachment {
  role: Role;
  /** Viewer only: relay-assigned routing id, handed out in `welcome`. */
  vid?: string;
  /**
   * Viewer only: AES-GCM-encrypted display name (`{iv, data}`, base64url),
   * encrypted in the browser with the share URL fragment key. The relay
   * stores and forwards it verbatim — never the plaintext. Null when the
   * hello carried no usable ciphertext; viewers render those as "Guest".
   */
  name?: NameCipher | null;
  /**
   * Last time (ms epoch) this socket proved liveness: hello, heartbeat, or
   * any frame. The alarm sweeps sockets silent past the timeout, because
   * close frames are not reliably delivered (proxies, mobile radios, tab
   * kills) — without the sweep, dead viewers accumulate as roster ghosts.
   * Stored in the attachment so it survives hibernation eviction.
   */
  lastSeen?: number;
}

/**
 * How often a healthy viewer sends `{t:"heartbeat"}` (plaintext liveness,
 * relay-visible routing metadata like hello — no privacy implication).
 * The viewer implements this cadence; the relay only enforces the sweep.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Sweep viewers silent longer than this. Worst-case ghost lifetime is this
 *  plus one alarm period. */
const PRESENCE_SWEEP_AFTER_MS = 45_000;
/** The shipper sends a keepalive every 45 s; sweep a VM socket silent much
 *  longer than that so a dead shipper stops black-holing viewer commands. */
const VM_SWEEP_AFTER_MS = 150_000;
/** How often the sweep alarm re-fires while any socket is attached. */
const SWEEP_ALARM_EVERY_MS = 20_000;
/**
 * Grace after the shipper socket closes before the box is declared dead.
 * The shipper's own retry loop reconnects with the same box id (backoff
 * caps at 30 s), so a shipper gone longer than this is not coming back —
 * a restart mints a fresh box id and the old URL stays dead. Only after
 * this grace does the relay persist `ended` and tell viewers the session
 * ended, so transient drops never flash a false "ended" page.
 */
const VM_GONE_GRACE_MS = 90_000;
/** DO storage keys for the box lifecycle. */
const ENDED_KEY = "ended";
const VM_GONE_AT_KEY = "vmGoneAt";

/** Max relay-visible envelope size. Well under the 32 MiB WS message limit. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
/** Ciphertext shape guard: an encrypted 32-char name is ~16 + ~88 chars; the
 *  cap is generous headroom, not a plaintext length check (the relay cannot
 *  see the plaintext). */
const MAX_CIPHER_CHARS = 2048;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Accept only a well-formed encrypted name; anything else (missing fields,
 * wrong types, absurd lengths, non-base64url chars, legacy plaintext)
 * becomes null so viewers render "Guest". The relay must never treat a
 * display name as readable text.
 */
function sanitizeNameCipher(v: unknown): NameCipher | null {
  if (!isRecord(v)) return null;
  const { iv, data } = v;
  if (typeof iv !== "string" || typeof data !== "string") return null;
  if (iv.length < 1 || data.length < 1) return null;
  if (iv.length > MAX_CIPHER_CHARS || data.length > MAX_CIPHER_CHARS) return null;
  if (!B64URL_RE.test(iv) || !B64URL_RE.test(data)) return null;
  return { iv, data };
}

/** Random viewer id (12 base64url chars). Routing metadata, not a secret. */
function newVid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class LiveRelay {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      // Box liveness probe for the viewer shell: lets the viewer show the
      // "session ended" page before the name gate instead of hanging on
      // "Connecting…". Only the lifecycle flag is exposed — never content.
      const url = new URL(request.url);
      if (url.pathname.endsWith("/status")) {
        let ended = false;
        try {
          ended = (await this.ctx.storage.get<boolean>(ENDED_KEY)) === true;
        } catch {
          // storage best-effort
        }
        let live = false;
        try {
          live = this.vmSocket() !== undefined;
        } catch {
          // ignore
        }
        return Response.json({ status: ended ? "ended" : live ? "live" : "unknown" });
      }
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable: the object may sleep while sockets stay open.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private viewers(): Array<{ ws: WebSocket; vid: string; name: NameCipher | null }> {
    const out: Array<{ ws: WebSocket; vid: string; name: NameCipher | null }> = [];
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === "viewer" && att.vid) {
          // Skip sockets the sweep has deemed dead: even if ws.close() hasn't
          // taken effect yet (half-open TCP), they must not appear in the roster.
          if (typeof att.lastSeen === "number" && now - att.lastSeen > PRESENCE_SWEEP_AFTER_MS) {
            continue;
          }
          out.push({ ws, vid: att.vid, name: att.name ?? null });
        }
      } catch {
        // attachment unreadable — treat as unregistered
      }
    }
    return out;
  }

  /**
   * Every attached viewer-role socket, without the presence-liveness
   * filter. Used when the box dies: a suspended mobile tab that missed
   * heartbeats still holds a socket and must learn the session ended
   * when it wakes — not silently rejoin a dead box.
   */
  private attachedViewers(): WebSocket[] {
    const out: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === "viewer" && att.vid) out.push(ws);
      } catch {
        // attachment unreadable — treat as unregistered
      }
    }
    return out;
  }

  private vmSocket(): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === "vm") return ws;
      } catch {
        // attachment unreadable — treat as unregistered
      }
    }
    return undefined;
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already gone
    }
  }

  private sendQuietly(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // peer died mid-send; its close handler cleans up
    }
  }

  /**
   * Push the current viewer roster to every connected viewer.
   *
   * `except` excludes one socket from both the roster and the recipients.
   * webSocketClose() passes the closing socket: in production the runtime
   * still lists it in getWebSockets() when the close event fires (it even
   * receives the broadcast), and its lastSeen is fresh so the 45 s
   * presence filter would not drop it — without the exclusion the roster
   * would never shrink on a clean viewer leave.
   */
  private broadcastPresence(except?: unknown): void {
    const viewers = this.viewers().filter(({ ws }) => ws !== except);
    const msg = JSON.stringify({
      t: "presence",
      viewers: viewers.map(({ vid, name }) => ({ vid, name })),
    });
    for (const { ws } of viewers) this.sendQuietly(ws, msg);
  }

  /**
   * (Re)arm the sweep alarm while any socket is attached. Alarms survive
   * hibernation eviction, so a box with a live viewer keeps being swept even
   * when the object sleeps between heartbeats.
   */
  private ensureSweepAlarm(): void {
    try {
      void this.ctx.storage.setAlarm(Date.now() + SWEEP_ALARM_EVERY_MS).catch(() => {
        // async storage failure (e.g. test harness) — sweep still works when
        // alarm() is invoked directly
      });
    } catch {
      // storage unavailable in some test harnesses — sweep still works when
      // alarm() is invoked directly
    }
  }

  /**
   * Alarm handler: close sockets that stopped proving liveness. Closing
   * (not just dropping from the roster) lets the runtime deliver
   * webSocketClose, which broadcasts the shrunken roster and tells the
   * shipper to drop that viewer's tails.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let live = 0;
    let reaped = 0;
    for (const ws of this.ctx.getWebSockets()) {
      let att: Attachment | null = null;
      try {
        att = ws.deserializeAttachment() as Attachment | null;
      } catch {
        continue;
      }
      if (!att || (att.role !== "vm" && att.role !== "viewer")) continue;
      const timeout = att.role === "vm" ? VM_SWEEP_AFTER_MS : PRESENCE_SWEEP_AFTER_MS;
      if (typeof att.lastSeen !== "number") {
        // Legacy attachment from before the liveness sweep deployed: stamp it
        // now so it gets one grace period, then normal timeouts apply.
        // Healthy sockets refresh lastSeen on their next heartbeat/frame;
        // silent ghosts get swept on a later pass.
        ws.serializeAttachment({ ...att, lastSeen: now } satisfies Attachment);
        live++;
        continue;
      }
      if (now - att.lastSeen > timeout) {
        this.closeQuietly(ws, 1001, "idle timeout");
        reaped++;
        continue;
      }
      live++;
    }
    // If we reaped ghosts, push the shrunken roster now: ws.close() on a
    // half-open socket may not trigger webSocketClose promptly, but viewers()
    // already filters stale sockets, so the broadcast will be correct.
    if (reaped > 0) this.broadcastPresence();
    // Box-end grace: the shipper socket closed; if no shipper reattaches
    // within VM_GONE_GRACE_MS the box is dead for good (restarts mint fresh
    // box ids, so the old URL never revives).
    let gracePending = false;
    try {
      const vmGoneAt = await this.ctx.storage.get<number>(VM_GONE_AT_KEY);
      if (typeof vmGoneAt === "number") {
        if (this.vmSocket()) {
          // Shipper reconnected inside the grace — the box lives on.
          await this.ctx.storage.delete(VM_GONE_AT_KEY);
        } else if (now - vmGoneAt > VM_GONE_GRACE_MS) {
          await this.endBox();
          return;
        } else {
          gracePending = true;
        }
      }
    } catch {
      // storage best-effort (some harnesses lack it)
    }
    if (live > 0 || gracePending) {
      this.ensureSweepAlarm();
    } else {
      try {
        await this.ctx.storage.deleteAlarm();
      } catch {
        // ignore
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Measure text frames in UTF-8 bytes: message.length counts UTF-16 code
    // units, which understates the wire size of non-ASCII payloads.
    const size =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > MAX_ENVELOPE_BYTES) {
      this.closeQuietly(ws, 1009, "frame too large");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      this.closeQuietly(ws, 1003, "invalid frame");
      return;
    }
    if (!isRecord(msg)) {
      this.closeQuietly(ws, 1003, "invalid frame");
      return;
    }

    let attachment: Attachment | null = null;
    try {
      attachment = ws.deserializeAttachment() as Attachment | null;
    } catch {
      attachment = null;
    }

    // First message on a fresh socket must be the plaintext hello.
    // (Plaintext role is routing metadata, like Excalidraw's room id; the
    // display name travels as ciphertext and the encrypted payloads that
    // follow stay opaque.)
    if (!attachment || (attachment.role !== "vm" && attachment.role !== "viewer")) {
      if (msg.t === "hello" && (msg.role === "vm" || msg.role === "viewer")) {
        if (msg.role === "vm") {
          // A box declared ended never revives: restarts mint fresh box
          // ids. A shipper helloing for an ended box is a zombie — tell it
          // to exit so it restarts with a new URL instead of sitting on a
          // dead box id.
          if (await this.boxEnded()) {
            this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
            this.closeQuietly(ws, 1000, "box ended");
            return;
          }
          // One shipper per box: a new shipper takes over from the old one.
          const existing = this.vmSocket();
          if (existing && existing !== ws) this.closeQuietly(existing, 1000, "replaced");
          ws.serializeAttachment({ role: "vm", lastSeen: Date.now() } satisfies Attachment);
          // The shipper reconnected inside the end grace — cancel it.
          try {
            await this.ctx.storage.delete(VM_GONE_AT_KEY);
          } catch {
            // storage best-effort (some harnesses lack it)
          }
          this.ensureSweepAlarm();
          return;
        }
        // A viewer joining a dead box learns it immediately instead of
        // hanging on "Connecting…" — this box can never come back.
        if (await this.boxEnded()) {
          this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
          this.closeQuietly(ws, 1000, "session ended");
          return;
        }
        // Viewers are never displaced: any number of viewers may watch the
        // same box at once.
        const vid = newVid();
        const name = sanitizeNameCipher(msg.name);
        ws.serializeAttachment({
          role: "viewer",
          vid,
          name,
          lastSeen: Date.now(),
        } satisfies Attachment);
        this.sendQuietly(ws, JSON.stringify({ t: "welcome", vid }));
        this.ensureSweepAlarm();
        this.broadcastPresence();
        return;
      }
      this.closeQuietly(ws, 1003, "hello first");
      return;
    }

    // The box is dead but this socket missed endBox (e.g. a suspended tab
    // whose socket survived). It learns the session ended on its next
    // message instead of silently rejoining a dead box — and its heartbeat
    // must not refresh the sweep clock below.
    if (attachment.role === "viewer" && (await this.boxEnded())) {
      this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
      this.closeQuietly(ws, 1000, "session ended");
      return;
    }

    // Plaintext liveness ping from a hello'd socket (viewer heartbeat or
    // anything the shipper sends outside frames). Refreshes the sweep clock.
    if (msg.t === "heartbeat") {
      try {
        ws.serializeAttachment({ ...attachment, lastSeen: Date.now() } satisfies Attachment);
      } catch {
        // attachment unwritable — the sweep will eventually reap this socket
      }
      return;
    }

    // Clean shipper shutdown: the box dies the moment the shipper says
    // goodbye — no grace needed, since a clean shutdown never reconnects
    // with this box id. Viewers learn it immediately.
    if (msg.t === "goodbye" && attachment.role === "vm") {
      await this.endBox();
      return;
    }

    if (msg.t !== "frame" || typeof msg.iv !== "string" || typeof msg.data !== "string") {
      this.closeQuietly(ws, 1003, "invalid frame");
      return;
    }

    if (attachment.role === "vm") {
      // Any VM frame — including the shipper's keepalive no-ops — proves the
      // shipper is alive. A dead shipper's ghost socket must not black-hole
      // viewer commands forever; the sweep reaps it past VM_SWEEP_AFTER_MS.
      try {
        ws.serializeAttachment({ ...attachment, lastSeen: Date.now() } satisfies Attachment);
      } catch {
        // attachment unwritable — the sweep will eventually reap this socket
      }
      // VM → viewers: route by the plaintext `via` tag the shipper echoed
      // back, or broadcast when absent (keepalive no-ops). Strip the routing
      // tag before delivery — viewers only ever see {t, iv, data}.
      const frame = JSON.stringify({ t: "frame", iv: msg.iv, data: msg.data });
      const via = typeof msg.via === "string" ? msg.via : undefined;
      if (via) {
        const target = this.viewers().find((v) => v.vid === via);
        if (target) this.sendQuietly(target.ws, frame);
        return; // unknown vid — drop
      }
      for (const { ws: viewer } of this.viewers()) this.sendQuietly(viewer, frame);
      return;
    }

    // Viewer → VM: tag the frame with the sender's vid so the shipper can
    // echo it back and the relay can route the response to this viewer.
    const vm = this.vmSocket();
    if (!vm) return; // shipper not connected — drop (viewer re-issues commands)
    this.sendQuietly(
      vm,
      JSON.stringify({ t: "frame", iv: msg.iv, data: msg.data, via: attachment.vid }),
    );
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // The closing socket may still carry its attachment: if it was a
    // viewer, tell the shipper so it can drop that viewer's tail
    // subscriptions instead of fanning out to a dead id.
    let att: Attachment | null = null;
    try {
      att = ws.deserializeAttachment() as Attachment | null;
    } catch {
      att = null;
    }
    if (att?.role === "viewer") {
      const vm = this.vmSocket();
      if (vm) this.sendQuietly(vm, JSON.stringify({ t: "viewer-left", via: att.vid }));
    }
    if (att?.role === "vm") {
      // The shipper is gone. Its retry loop reconnects with the same box id
      // (backoff caps at 30 s) — start the end grace; the sweep declares the
      // box dead only if no shipper reattaches in time. Skip when the box
      // already ended (the goodbye path handled it).
      try {
        const ended = await this.ctx.storage.get<boolean>(ENDED_KEY);
        if (ended !== true) {
          await this.ctx.storage.put(VM_GONE_AT_KEY, Date.now());
          await this.ctx.storage.setAlarm(Date.now() + SWEEP_ALARM_EVERY_MS);
        }
      } catch {
        // storage best-effort (some harnesses lack it)
      }
    }
    // The closed socket is already removed from getWebSockets() — or, in
    // production, still listed but excluded below: if it was a viewer, push
    // the shrunken roster to whoever remains.
    this.broadcastPresence(ws);
    if (this.ctx.getWebSockets().length === 0) {
      // Don't disarm while the end grace is pending — the alarm is what
      // declares the box dead when the shipper never comes back.
      let gracePending = false;
      try {
        gracePending = typeof (await this.ctx.storage.get(VM_GONE_AT_KEY)) === "number";
      } catch {
        // storage best-effort
      }
      if (!gracePending) {
        try {
          await this.ctx.storage.deleteAlarm();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Has this box been declared permanently dead? Best-effort: storage may
   * be unavailable in some harnesses, in which case the answer is no.
   */
  private async boxEnded(): Promise<boolean> {
    try {
      return (await this.ctx.storage.get<boolean>(ENDED_KEY)) === true;
    } catch {
      return false;
    }
  }

  /**
   * Declare the box permanently dead: persist the flag so late joiners and
   * the /status probe learn it instantly, notify attached viewers, and drop
   * their sockets. A restart mints a fresh box id — this one never revives.
   * The relay still sees no plaintext: only the lifecycle flag is stored.
   */
  private async endBox(): Promise<void> {
    try {
      await this.ctx.storage.put(ENDED_KEY, true);
      await this.ctx.storage.delete(VM_GONE_AT_KEY);
      await this.ctx.storage.deleteAlarm();
    } catch {
      // storage best-effort (some harnesses lack it)
    }
    const msg = JSON.stringify({ t: "session-ended" });
    // Every attached viewer socket — not just the presence-filtered roster:
    // a suspended tab that missed heartbeats still holds a socket and must
    // learn the session ended when it wakes.
    for (const ws of this.attachedViewers()) {
      this.sendQuietly(ws, msg);
      this.closeQuietly(ws, 1000, "session ended");
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closeQuietly(ws, 1011, "socket error");
  }
}
