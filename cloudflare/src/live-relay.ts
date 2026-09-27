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
 * - viewer-joined / viewer-left: plaintext control notices the relay sends
 *   to the shipper socket when a viewer hello lands / a viewer socket
 *   closes. Each notice carries an absolute `viewers` count (remaining
 *   viewers after the transition), as does the shipper's `hello-ok` ack —
 *   the CLI displays the absolute count instead of doing its own
 *   base+delta arithmetic, so a stale viewer reaped after a shipper
 *   reconnect can never make the displayed count drift. Routing metadata
 *   only — the shipper shows counts, never names (names are ciphertext it
 *   cannot read).
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
  /** Shipper only: private capability established by the first modern VM hello. */
  shipperClaim?: string;
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
  /**
   * Shipper only: set when a newer shipper displaced this socket. The
   * runtime may still list the closing socket in getWebSockets() while
   * the close completes, so vmSocket() skips displaced sockets —
   * presence notices and viewer frames go to the replacement, and its
   * close must not start the box-end grace.
   */
  displaced?: boolean;
  /**
   * Shipper only: set when the liveness sweep has declared this socket dead
   * and asked the runtime to close it. The runtime may keep returning a
   * half-open socket from getWebSockets() even when webSocketClose never
   * arrives, so routing and reconnect checks must ignore reaped shippers.
   */
  reaped?: boolean;
  /**
   * Viewer only: set when the sweep alarm actually delivered this viewer's
   * leave notice to an attached shipper while reaping the socket.
   * webSocketClose — and later alarms, while the half-open socket lingers —
   * must not double-notify. The flag is set only when a shipper was there
   * to hear the notice; otherwise a later alarm or the close callback
   * retries.
   */
  leaveNotified?: boolean;
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
/**
 * Set once a shipper first claims this box (never deleted). Lets a viewer
 * hello distinguish "this box never had a shipper" (fail fast after a
 * bounded wait for an in-flight hello — it can never come back) from "the
 * shipper died and may reconnect inside the end grace" or "the DO restarted
 * and the shipper hasn't re-hello'd yet".
 */
const VM_SEEN_KEY = "vmSeen";
/** Private shipper capability. Relay-visible, but never present in a share URL. */
const VM_CLAIM_KEY = "vmClaim";
/**
 * How long a viewer hello waits for a shipper hello that may still be in
 * flight (or moments away — e.g. the shipper re-helloing after a deploy
 * evicted the DO) before concluding the box never had a shipper. A missing
 * key alone is not proof the box is permanently dead: the CLI prints the
 * share URL only after its first hello is acked, but a viewer can still win
 * the race against a re-hello in the seconds after a restart. Bounded and
 * short — a truly dead box still fails in seconds, not the full retry
 * budget.
 */
let neverSeenWaitMs = 5000;
/** Test hook: shrink the never-seen wait so unit tests don't sleep. */
export function __setNeverSeenWaitMs(ms: number): void {
  neverSeenWaitMs = ms;
}

/** Max relay-visible envelope size. Well under the 32 MiB WS message limit. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
/** Ciphertext shape guard: an encrypted 32-char name is ~16 + ~88 chars; the
 *  cap is generous headroom, not a plaintext length check (the relay cannot
 *  see the plaintext). */
const MAX_CIPHER_CHARS = 2048;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const BOX_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SHIPPER_CLAIM_DOMAIN = "vibe-replay-shipper-claim:v1:";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Derive the 128-bit public commitment used by modern shipper box ids. */
async function shipperClaimBoxId(claim: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${SHIPPER_CLAIM_DOMAIN}${claim}`),
    ),
  );
  return base64urlEncode(digest.slice(0, 16));
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
  /** Box id captured from the current fetch; set again on every reconnect. */
  private boxId: string | null = null;
  /** In-memory mirror for test harnesses without Durable Object storage. */
  private shipperClaim: string | null = null;
  /**
   * Resolvers for viewer hellos waiting on a possibly-imminent shipper
   * hello. Drained (notified) every time a shipper hello finishes — the
   * waiter then re-checks box state instead of concluding the box never
   * had a shipper. This closes both the hello/hello interleave race and
   * the race where a viewer arrives while the shipper is re-helloing
   * after a deploy evicted the DO.
   */
  private shipperHelloWaiters: Array<() => void> = [];

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  /** True only when a syntactically valid private claim commits to this public box id. */
  private async claimCommitsToCurrentBox(value: unknown): Promise<boolean> {
    if (
      typeof value !== "string" ||
      value.length < 32 ||
      value.length > 128 ||
      !B64URL_RE.test(value) ||
      this.boxId === null
    ) {
      return false;
    }
    return (await shipperClaimBoxId(value)) === this.boxId;
  }

  /**
   * Authorize a VM hello. A modern shipper establishes a random capability
   * before the share URL is exposed; subsequent VM takeovers must present the
   * same value. Legacy shippers without a claim are accepted only while no
   * capability has ever been established, and their `goodbye` cannot end the
   * box immediately (the normal disconnect grace still cleans it up).
   */
  private async authorizeShipperClaim(
    value: unknown,
    boxSeenBefore: boolean,
  ): Promise<string | null | false> {
    const claim =
      typeof value === "string" &&
      value.length >= 32 &&
      value.length <= 128 &&
      B64URL_RE.test(value)
        ? value
        : null;

    if (this.shipperClaim) return claim === this.shipperClaim ? this.shipperClaim : false;

    const storage = this.ctx.storage;
    if (storage?.get && storage?.put) {
      try {
        const stored = await storage.get<string>(VM_CLAIM_KEY);
        const durableSeen = (await storage.get<boolean>(VM_SEEN_KEY)) === true;
        if (typeof stored === "string" && stored.length > 0) {
          this.shipperClaim = stored;
          return claim === stored ? stored : false;
        }
        // Modern CLIs derive the public box id from this private claim. That
        // commitment survives a rolling deployment even when an older Worker
        // accepted the hello but ignored the unknown claim field. It lets the
        // upgraded Worker distinguish that legitimate reconnect from a share
        // recipient attempting to become the first claimant of a truly
        // legacy random box.
        const claimMatchesBox =
          claim !== null && this.boxId !== null && (await shipperClaimBoxId(claim)) === this.boxId;
        if (claim !== null && this.boxId !== null && !claimMatchesBox) return false;
        // A legacy box that has already had a shipper can reconnect only as
        // legacy. Once the public URL exists, any viewer knows the box id, so
        // a later caller must never be allowed to become the first claimant
        // and gain permanent-goodbye authority. Claimless reconnects remain
        // compatible with pre-capability CLIs, but they never acquire that
        // authority and stay on the ordinary disconnect/grace lifecycle.
        if ((durableSeen || boxSeenBefore) && claim && !claimMatchesBox) return false;
        // Once a legacy box has acknowledged its first shipper, a later
        // claimless socket has no credential that distinguishes it from a
        // share recipient. Keep the first connection compatible, but fail
        // closed on unauthenticated reconnects. Modern CLIs can reconnect via
        // the box-id commitment above.
        if (!claim) return durableSeen || boxSeenBefore ? false : null;
        await storage.put(VM_CLAIM_KEY, claim);
        this.shipperClaim = claim;
        return claim;
      } catch {
        // Storage-backed boxes fail closed: losing claim state must never
        // allow an arbitrary viewer to seize the VM role.
        return false;
      }
    }

    // Plain unit-test harnesses have no durable storage. Preserve the same
    // semantics for the lifetime of this LiveRelay instance.
    const claimMatchesBox =
      claim !== null && this.boxId !== null && (await shipperClaimBoxId(claim)) === this.boxId;
    if (claim !== null && this.boxId !== null && !claimMatchesBox) return false;
    if (boxSeenBefore && claim && !claimMatchesBox) return false;
    if (!claim) return boxSeenBefore ? false : null;
    this.shipperClaim = claim;
    return claim;
  }

  /** Durable "a shipper once claimed this box" flag; false on any storage trouble. */
  private async vmSeen(): Promise<boolean> {
    try {
      const p = this.ctx.storage?.get<boolean>(VM_SEEN_KEY);
      return p ? (await p) === true : false;
    } catch {
      return false;
    }
  }

  /**
   * Resolve when a shipper hello completes, or after neverSeenWaitMs —
   * whichever comes first. Lets a viewer hello that found no VM socket
   * give a possibly-imminent shipper hello a bounded moment before
   * declaring the box permanently dead.
   */
  private waitForShipperHello(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.shipperHelloWaiters.indexOf(done);
        if (i >= 0) this.shipperHelloWaiters.splice(i, 1);
        resolve();
      }, neverSeenWaitMs);
      this.shipperHelloWaiters.push(done);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const maybeBoxId = parts.at(-1) === "status" ? parts.at(-2) : parts.at(-1);
    if (maybeBoxId && BOX_ID_RE.test(maybeBoxId)) this.boxId = maybeBoxId;
    if (request.headers.get("Upgrade") !== "websocket") {
      // Box liveness probe for the viewer shell: lets the viewer show the
      // "session ended" page before the name gate instead of hanging on
      // "Connecting…". Only the lifecycle flag is exposed — never content.
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
        // "ended" means permanently dead: the shipper declared it dead.
        // "unknown" covers everything else — the shipper died inside the
        // end grace, the DO restarted and the shipper hasn't re-hello'd
        // yet, or the box never had a shipper. The probe stays
        // conservative on purpose: an absent vmSeen key alone is not proof
        // the box can never come back (a shipper hello may still be on its
        // way), and a false "ended" here is terminal for the viewer page.
        // A viewer websocket that finds no shipper gets the fast
        // session-ended instead of hanging on "Connecting…".
        const dead = ended;
        return Response.json({ status: dead ? "ended" : live ? "live" : "unknown" });
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
        // A displaced shipper is already closing: presence notices and
        // viewer frames must reach the replacement, never the dying
        // socket (the runtime may still list it while the close
        // completes).
        if (att?.role === "vm" && !att.displaced && !att.reaped) return ws;
      } catch {
        // attachment unreadable — treat as unregistered
      }
    }
    return undefined;
  }

  /**
   * The shipper socket eligible for a sweep-time viewer-leave notice.
   * Unlike vmSocket(), this also excludes a shipper that is itself past
   * the sweep timeout, regardless of visit order: after a takeover the
   * replacement VM is newer than existing viewers, so a stale viewer can
   * be visited first while the stale shipper hasn't been reaped yet. A
   * send() to such a shipper may be accepted without delivery, and the
   * leaveNotified mark would then suppress the retry a reconnecting
   * shipper needs. A stale shipper is reaped in this same pass anyway.
   */
  private notifyingVmSocket(now: number): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role !== "vm" || att.displaced || att.reaped) continue;
        if (typeof att.lastSeen === "number" && now - att.lastSeen > VM_SWEEP_AFTER_MS) continue;
        return ws;
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
    let gracePersistenceRetry = false;
    let staleVmWithoutReapedMarker: WebSocket | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      let att: Attachment | null = null;
      try {
        att = ws.deserializeAttachment() as Attachment | null;
      } catch {
        continue;
      }
      if (!att || (att.role !== "vm" && att.role !== "viewer")) continue;
      if (att.role === "vm" && att.reaped) continue;
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
        if (att.role === "vm") {
          // close() on a half-open WebSocket may never produce
          // webSocketClose, while getWebSockets() can keep returning it.
          // Persist the end-grace state before hiding the VM from vmSocket().
          // If storage is transiently unavailable, leave it unreaped so a
          // later alarm or close callback can retry instead of stranding the
          // box forever in "unknown".
          let graceReady = false;
          try {
            const ended = await this.ctx.storage.get<boolean>(ENDED_KEY);
            const vmGoneAt = await this.ctx.storage.get<number>(VM_GONE_AT_KEY);
            if (ended === true || typeof vmGoneAt === "number") {
              graceReady = true;
            } else {
              await this.ctx.storage.put(VM_GONE_AT_KEY, now);
              graceReady = true;
              try {
                await this.ctx.storage.setAlarm(now + SWEEP_ALARM_EVERY_MS);
              } catch {
                // The durable grace timestamp is the important part. The
                // normal alarm tail below retries scheduling while grace is
                // pending.
              }
            }
          } catch {
            // Keep the sweep armed so a half-open socket whose close callback
            // never arrives gets another chance to persist VM_GONE_AT_KEY.
            gracePersistenceRetry = true;
          }
          if (graceReady) {
            try {
              ws.serializeAttachment({ ...att, reaped: true } satisfies Attachment);
            } catch {
              // The durable grace timestamp exists, but vmSocket() would
              // still see this half-open stale VM because its attachment
              // could not be marked reaped. Remember exactly this socket so
              // the grace tail does not mistake it for a real reconnect.
              staleVmWithoutReapedMarker = ws;
              gracePersistenceRetry = true;
            }
          }
        }
        if (att.role === "viewer" && typeof att.vid === "string" && !att.leaveNotified) {
          // A half-open socket's close may never deliver webSocketClose
          // promptly, and the leave notice lives only in that callback —
          // notify the shipper now so its watcher count and the dead
          // viewer's tail subscriptions don't linger. The reaped viewer is
          // already stale-excluded from viewers(), so the absolute count is
          // exact. Mark the socket only after the send observably succeeds:
          // an attached shipper socket can still die mid-send, and the mark
          // must not suppress the retry a replacement shipper needs.
          // When no shipper is attached — or the send fails — the flag stays
          // clear so a later alarm or the delayed close callback retries.
          // Never entrust the notice to a shipper that is itself stale:
          // notifyingVmSocket() excludes it regardless of sweep visit
          // order.
          const vm = this.notifyingVmSocket(now);
          if (vm) {
            let sent = false;
            try {
              vm.send(
                JSON.stringify({ t: "viewer-left", via: att.vid, viewers: this.viewers().length }),
              );
              sent = true;
            } catch {
              // peer died mid-send — leave the flag clear to retry
            }
            if (sent) {
              try {
                ws.serializeAttachment({ ...att, leaveNotified: true } satisfies Attachment);
              } catch {
                // best effort — the mark may not stick on a dead socket
              }
            }
          }
        }
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
        const attachedVm = this.vmSocket();
        if (attachedVm && attachedVm !== staleVmWithoutReapedMarker) {
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
      // A transient grace-state read must not disarm the only retry path for
      // a reaped half-open VM whose close callback may never arrive.
      gracePersistenceRetry = true;
    }
    if (live > 0 || gracePending || gracePersistenceRetry) {
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

    // A displaced shipper lost a takeover race: its socket is already being
    // closed, but the runtime may still dispatch messages it queued before
    // the close completes (a delayed `goodbye`, heartbeat, or frame).
    // Ignore everything from it — a stale `goodbye` must not endBox() a box
    // the replacement shipper now owns, and its heartbeats/frames belong to
    // the old epoch.
    if (attachment?.role === "vm" && (attachment.displaced || attachment.reaped)) {
      return;
    }

    // First message on a fresh socket must be the plaintext hello.
    // (Plaintext role is routing metadata only; the display name travels
    // as ciphertext and the encrypted payloads that follow stay opaque.)
    if (!attachment || (attachment.role !== "vm" && attachment.role !== "viewer")) {
      if (msg.t === "hello" && (msg.role === "vm" || msg.role === "viewer")) {
        if (msg.role === "vm") {
          // A viewer hello racing this claim waits on the waiter list
          // instead of concluding the box never had a shipper.
          try {
            // A box declared ended never revives: restarts mint fresh box
            // ids. A shipper helloing for an ended box is a zombie — tell it
            // to exit so it restarts with a new URL instead of sitting on a
            // dead box id.
            if (await this.boxEnded()) {
              this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
              this.closeQuietly(ws, 1000, "box ended");
              return;
            }
            const activeBeforeAuth = this.vmSocket();
            if (activeBeforeAuth && activeBeforeAuth !== ws) {
              try {
                const existingAttachment =
                  activeBeforeAuth.deserializeAttachment() as Attachment | null;
                // A live pre-capability shipper has no identity proof that a
                // second claimless socket can reproduce. Do not let a public
                // share recipient displace it. If the legacy socket actually
                // drops, vmSocket() disappears and the legitimate claimless
                // reconnect is accepted below during the normal grace window.
                //
                // Rolling-deploy exception: a modern CLI may have connected
                // to the previous Worker, which ignored its then-unknown
                // claim field and left an unclaimed attachment behind. Its
                // private claim still commits to the public box id, so it can
                // authenticate before the stale pre-upgrade socket is swept.
                if (existingAttachment?.role === "vm" && !existingAttachment.shipperClaim) {
                  if (!(await this.claimCommitsToCurrentBox(msg.claim))) {
                    this.closeQuietly(ws, 1008, "legacy shipper already connected");
                    return;
                  }
                }
              } catch {
                this.closeQuietly(ws, 1008, "invalid shipper state");
                return;
              }
            }
            const shipperClaim = await this.authorizeShipperClaim(msg.claim, await this.vmSeen());
            if (shipperClaim === false) {
              this.closeQuietly(ws, 1008, "invalid shipper claim");
              return;
            }
            // One shipper per box: a new shipper takes over from the old one.
            // Re-read after authorization: concurrent first hellos can race
            // across awaits, and the later one must still displace whichever
            // authenticated socket won the race rather than using a stale
            // pre-auth snapshot.
            const existing = this.vmSocket();
            if (existing && existing !== ws) {
              // Mark the old socket displaced *before* closing it: the
              // runtime may still list it in getWebSockets() while the
              // close completes, and vmSocket() must already resolve to
              // the new claim in that window — otherwise a viewer joining
              // right now would send its join notice to the dying socket
              // while the new shipper's hello-ok snapshot (taken before
              // the join) leaves its watcher count stale.
              try {
                existing.serializeAttachment({
                  role: "vm",
                  lastSeen: 0,
                  displaced: true,
                } satisfies Attachment);
              } catch {
                // already gone
              }
              this.closeQuietly(existing, 1000, "replaced");
            }
            ws.serializeAttachment({
              role: "vm",
              lastSeen: Date.now(),
              ...(shipperClaim ? { shipperClaim } : {}),
            } satisfies Attachment);
            // The shipper reconnected inside the end grace — cancel it.
            try {
              await this.ctx.storage.delete(VM_GONE_AT_KEY);
              await this.ctx.storage.put(VM_SEEN_KEY, true);
            } catch {
              // storage best-effort (some harnesses lack it)
            }
            this.ensureSweepAlarm();
          } finally {
            // Wake any waiting viewer hellos: they re-check box state now
            // that the claim (and its durable vmSeen write) has landed.
            for (const w of this.shipperHelloWaiters.splice(0)) w();
          }
          // The claim landed — ack so the shipper knows it may print the
          // share URL. Viewers can therefore never open the URL before the
          // relay knows the shipper. (A zombie hello returned early above
          // and gets no ack; its CLI exits on the session-ended instead.)
          // `viewers` lets a (re)connecting shipper resync its watcher
          // count: viewers that joined while it was away never sent it a
          // join notice. Viewers get `welcome`, never `hello-ok`.
          const currentViewers = this.viewers();
          this.sendQuietly(
            ws,
            JSON.stringify({
              t: "hello-ok",
              viewers: currentViewers.length,
              // Still ciphertext: the relay cannot read names. The shipper
              // owns the fragment key and may decrypt this roster locally.
              presence: currentViewers.map(({ vid, name }) => ({ vid, name })),
            }),
          );
          return;
        }
        // A viewer joining a dead box learns it immediately instead of
        // hanging on "Connecting…" — this box can never come back.
        if (await this.boxEnded()) {
          this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
          this.closeQuietly(ws, 1000, "session ended");
          return;
        }
        // A box that never had a shipper can never come back either: fail
        // the viewer fast instead of burning the whole connect/retry
        // budget on timeouts. A box whose shipper died keeps the normal
        // path — it may reconnect inside the end grace, and a DO restart
        // must not strand its viewers with a false ended page (VM_SEEN_KEY
        // is durable storage, so it survives restarts).
        if (!this.vmSocket()) {
          // Fail fast only on positive knowledge: storage available and the
          // box never had a shipper. Without storage (some harnesses) we
          // can't know — keep the old welcome-and-retry behavior.
          let storageOk = false;
          let seen = false;
          try {
            const p = this.ctx.storage?.get<boolean>(VM_SEEN_KEY);
            if (p) {
              seen = (await p) === true;
              storageOk = true;
            }
          } catch {
            // storage best-effort
          }
          if (storageOk && !seen) {
            // …but an absent key is not proof the box can never come back:
            // a shipper hello may be in flight, or moments away (a viewer
            // racing a re-hello after a deploy evicted the DO). Give it a
            // bounded moment, then re-check before declaring the box
            // permanently dead.
            await this.waitForShipperHello();
            if (!this.vmSocket() && !(await this.vmSeen())) {
              this.sendQuietly(ws, JSON.stringify({ t: "session-ended" }));
              this.closeQuietly(ws, 1000, "box unknown");
              return;
            }
          }
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
        // Tell the shipper a viewer joined so the CLI operator can see who
        // is watching — symmetric with the viewer-left notice on close.
        // The absolute count is authoritative: the joining viewer is already
        // in viewers() (fresh lastSeen). If the shipper is away it learns
        // the count from its next hello-ok instead; no notice is ever queued.
        const vm = this.vmSocket();
        if (vm)
          this.sendQuietly(
            vm,
            JSON.stringify({
              t: "viewer-joined",
              via: vid,
              viewers: this.viewers().length,
              name,
            }),
          );
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
      const now = Date.now();
      // A viewer that missed heartbeats for over 45 s dropped out of the
      // stale-filtered roster — and out of any hello-ok snapshot taken while
      // it was stale. If it resumes heartbeating before the sweep reaps its
      // still-open socket, the shipper would undercount it indefinitely: no
      // join notice and no fresh snapshot would ever repair the count. Treat
      // the revival as a rejoin and notify with the absolute count. A shipper
      // that stayed connected throughout already tracks this vid, so its CLI
      // dedupes the notice; a shipper that resynced mid-staleness gets its
      // count fixed.
      const revivedViewer =
        attachment.role === "viewer" &&
        typeof attachment.vid === "string" &&
        typeof attachment.lastSeen === "number" &&
        now - attachment.lastSeen > PRESENCE_SWEEP_AFTER_MS;
      try {
        ws.serializeAttachment({
          ...attachment,
          lastSeen: now,
          // A revived viewer starts a fresh presence epoch: if the sweep
          // already sent viewer-left for the stale interval, clear the mark —
          // otherwise the viewer's eventual departure would never notify the
          // shipper again.
          ...(revivedViewer ? { leaveNotified: false } : undefined),
        } satisfies Attachment);
      } catch {
        // attachment unwritable — the sweep will eventually reap this socket
      }
      if (revivedViewer && attachment.role === "viewer" && typeof attachment.vid === "string") {
        const vm = this.vmSocket();
        if (vm)
          this.sendQuietly(
            vm,
            JSON.stringify({
              t: "viewer-joined",
              via: attachment.vid,
              viewers: this.viewers().length,
              name: attachment.name ?? null,
            }),
          );
      }
      return;
    }

    // Clean shipper shutdown: the box dies the moment the shipper says
    // goodbye — no grace needed, since a clean shutdown never reconnects
    // with this box id. Viewers learn it immediately.
    if (msg.t === "goodbye" && attachment.role === "vm") {
      // Only a VM authenticated with the private capability may permanently
      // end the box. During a rolling deploy, an older Worker may have
      // accepted a modern shipper hello without persisting the then-unknown
      // claim on the socket attachment; in that case the goodbye's claim can
      // still prove ownership through the public box-id commitment.
      const authenticated =
        (attachment.shipperClaim && msg.claim === attachment.shipperClaim) ||
        (!attachment.shipperClaim && (await this.claimCommitsToCurrentBox(msg.claim)));
      if (authenticated) {
        await this.endBox();
      }
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
    if (att?.role === "viewer" && !att.leaveNotified) {
      const vm = this.vmSocket();
      if (vm) {
        // Absolute remaining-viewer count, excluding the closing socket
        // explicitly: the runtime may still list it in getWebSockets() when
        // this fires (healthy close), while a swept stale socket is already
        // filtered out of viewers(). Either way the count is exact.
        const remaining = this.viewers().filter((v) => v.ws !== ws).length;
        this.sendQuietly(
          vm,
          JSON.stringify({ t: "viewer-left", via: att.vid, viewers: remaining }),
        );
      }
    }
    if (att?.role === "vm" && !att.displaced && !att.reaped) {
      // The shipper is gone. Its retry loop reconnects with the same box id
      // (backoff caps at 30 s) — start the end grace; the sweep declares the
      // box dead only if no shipper reattaches in time. Skip when the box
      // already ended (the goodbye path handled it). A displaced socket's
      // close never starts the grace: its replacement is already connected.
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
