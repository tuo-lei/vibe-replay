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
 * - presence: each viewer announces a display name in its hello; the relay
 *   broadcasts `{t:"presence", viewers:[{vid,name}]}` to all viewers
 *   whenever someone joins or leaves.
 *
 * Uses the Hibernation API, so an idle box (VM holding its socket open with
 * nobody watching) costs ~zero duration billing: the runtime answers
 * ping/pong without waking the object.
 *
 * Note: this class deliberately does NOT import from "cloudflare:workers".
 * A plain class with the right shape works as a Durable Object, and it keeps
 * the module importable in plain vitest runs (which can't resolve the
 * runtime-only module).
 */

type Role = "vm" | "viewer";

interface Attachment {
  role: Role;
  /** Viewer only: relay-assigned routing id, handed out in `welcome`. */
  vid?: string;
  /** Viewer only: sanitized display name shown in the presence roster. */
  name?: string;
}

/** Max relay-visible envelope size. Well under the 32 MiB WS message limit. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
/** Display names are relay-visible metadata: keep them short. */
const MAX_NAME_CHARS = 32;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Random viewer id (12 base64url chars). Routing metadata, not a secret. */
function newVid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Clamp a viewer-supplied display name to safe, short, printable text. */
function sanitizeName(v: unknown): string {
  if (typeof v !== "string") return "Guest";
  const cleaned = v.replace(/\p{Cc}/gu, "").trim();
  return cleaned.slice(0, MAX_NAME_CHARS) || "Guest";
}

export class LiveRelay {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable: the object may sleep while sockets stay open.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private viewers(): Array<{ ws: WebSocket; vid: string; name: string }> {
    const out: Array<{ ws: WebSocket; vid: string; name: string }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === "viewer" && att.vid) {
          out.push({ ws, vid: att.vid, name: att.name ?? "Guest" });
        }
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

  /** Push the current viewer roster to every connected viewer. */
  private broadcastPresence(): void {
    const viewers = this.viewers();
    const msg = JSON.stringify({
      t: "presence",
      viewers: viewers.map(({ vid, name }) => ({ vid, name })),
    });
    for (const { ws } of viewers) this.sendQuietly(ws, msg);
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
    // (Plaintext role/name are routing metadata, like Excalidraw's room id —
    // the encrypted payloads that follow stay opaque.)
    if (!attachment || (attachment.role !== "vm" && attachment.role !== "viewer")) {
      if (msg.t === "hello" && (msg.role === "vm" || msg.role === "viewer")) {
        if (msg.role === "vm") {
          // One shipper per box: a new shipper takes over from the old one.
          const existing = this.vmSocket();
          if (existing && existing !== ws) this.closeQuietly(existing, 1000, "replaced");
          ws.serializeAttachment({ role: "vm" } satisfies Attachment);
          return;
        }
        // Viewers are never displaced: any number of viewers may watch the
        // same box at once, Excalidraw-style.
        const vid = newVid();
        const name = sanitizeName(msg.name);
        ws.serializeAttachment({ role: "viewer", vid, name } satisfies Attachment);
        this.sendQuietly(ws, JSON.stringify({ t: "welcome", vid }));
        this.broadcastPresence();
        return;
      }
      this.closeQuietly(ws, 1003, "hello first");
      return;
    }

    if (msg.t !== "frame" || typeof msg.iv !== "string" || typeof msg.data !== "string") {
      this.closeQuietly(ws, 1003, "invalid frame");
      return;
    }

    if (attachment.role === "vm") {
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
    try {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role === "viewer") {
        const vm = this.vmSocket();
        if (vm) this.sendQuietly(vm, JSON.stringify({ t: "viewer-left", via: att.vid }));
      }
    } catch {
      // attachment unreadable — nothing to clean up remotely
    }
    // The closed socket is already removed from getWebSockets(): if it was
    // a viewer, push the shrunken roster to whoever remains.
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closeQuietly(ws, 1011, "socket error");
  }
}
