/**
 * LiveRelay — the dumb pipe for `vibe-replay relay`.
 *
 * One Durable Object instance per box id (`live:<boxId>`). It holds at most
 * two WebSockets: the VM shipper (`role: "vm"`) and the viewer (`role:
 * "viewer"`), and forwards opaque `{t:"frame", iv, data}` envelopes between
 * them verbatim.
 *
 * The relay NEVER sees plaintext: every command/response payload is
 * AES-256-GCM encrypted end-to-end between the VM and the viewer with a key
 * that lives only in the share URL fragment. This mirrors excalidraw-room,
 * whose socket handler forwards `encryptedData` without decrypting it.
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
}

/** Max relay-visible envelope size. Well under the 32 MiB WS message limit. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

  private socketWithRole(role: Role, except?: WebSocket): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      if (except && ws === except) continue;
      try {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.role === role) return ws;
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
    // (Plaintext role is routing metadata, like Excalidraw's room id —
    // the encrypted payloads that follow stay opaque.)
    if (!attachment || (attachment.role !== "vm" && attachment.role !== "viewer")) {
      if (msg.t === "hello" && (msg.role === "vm" || msg.role === "viewer")) {
        const existing = this.socketWithRole(msg.role, ws);
        if (existing) this.closeQuietly(existing, 1000, "replaced");
        ws.serializeAttachment({ role: msg.role } satisfies Attachment);
        return;
      }
      this.closeQuietly(ws, 1003, "hello first");
      return;
    }

    // Opaque frame: forward verbatim to the other role, nothing else.
    if (msg.t !== "frame" || typeof msg.iv !== "string" || typeof msg.data !== "string") {
      this.closeQuietly(ws, 1003, "invalid frame");
      return;
    }
    const peerRole: Role = attachment.role === "vm" ? "viewer" : "vm";
    const peer = this.socketWithRole(peerRole);
    if (!peer) return; // peer not connected — drop (viewer re-issues commands)
    try {
      peer.send(JSON.stringify({ t: "frame", iv: msg.iv, data: msg.data }));
    } catch {
      // peer died mid-send; its close handler cleans up
    }
  }

  async webSocketClose(): Promise<void> {
    // Sockets are removed from getWebSockets() automatically.
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closeQuietly(ws, 1011, "socket error");
  }
}
