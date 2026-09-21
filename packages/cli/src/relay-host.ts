import {
  decryptFrame,
  encryptFrame,
  exportKeyString,
  generateContentKey,
  randomBoxId,
  type EncryptedFrame,
} from "./relay-crypto.js";

export const DEFAULT_RELAY_ORIGIN = "https://vibe-replay.com";
export const RELAY_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const RELAY_CHUNK_PLAINTEXT_BYTES = 512 * 1024;
export const RELAY_MAX_CHUNKS = 64;
export const RELAY_MAX_RESPONSE_BYTES = RELAY_CHUNK_PLAINTEXT_BYTES * RELAY_MAX_CHUNKS;

const KEEPALIVE_MS = 45_000;
const DEAD_BOX_RETRY_EXIT_MS = 150_000;

export interface RelayHostOptions {
  relayOrigin?: string;
  /** Public page path. WebSocket traffic always goes through /live/:boxId. */
  sharePath?: string;
  handleCommand: (
    message: Record<string, unknown>,
    via?: string,
  ) => Promise<Record<string, unknown>>;
  onViewerLeft?: (via: string) => void;
  onPermanentEnd?: () => void;
  onConnectionChange?: (state: "connected" | "retrying" | "ended", detail?: string) => void;
}

export interface RelayHostHandle {
  boxId: string;
  shareUrl: string;
  /** Resolves once the relay has durably acknowledged the shipper hello. */
  ready: Promise<void>;
  stop: () => Promise<void>;
}

function validateRelayOrigin(origin: string): void {
  const u = new URL(origin);
  const loopback =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname === "::1";
  if (u.protocol === "http:" && !loopback) {
    throw new Error(
      `refusing cleartext relay origin ${origin}: use https (http://localhost is allowed for local testing)`,
    );
  }
}

function splitUtf8(json: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of json) {
    const cp = ch.codePointAt(0) as number;
    const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (curBytes + bytes > maxBytes && cur.length > 0) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += bytes;
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/**
 * Create one E2E-encrypted shipper attached to the shared LiveRelay Durable
 * Object. The relay sees only box/routing metadata and opaque ciphertext.
 * Command semantics stay entirely local to the caller.
 */
export async function createRelayHost(options: RelayHostOptions): Promise<RelayHostHandle> {
  const origin = (options.relayOrigin ?? DEFAULT_RELAY_ORIGIN).replace(/\/$/, "");
  validateRelayOrigin(origin);

  const boxId = randomBoxId();
  const { key, raw } = await generateContentKey();
  const keyString = exportKeyString(raw);
  const wsUrl = `${origin.replace(/^http/, "ws")}/live/${boxId}`;
  const sharePath = (options.sharePath ?? "live").replace(/^\/+|\/+$/g, "");
  const shareUrl = `${origin}/${sharePath}/${boxId}#${keyString}`;

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectDelayMs = 2000;
  let everConnected = false;
  let outageBeganAt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const sendFrame = async (payload: unknown, via?: string): Promise<boolean> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame: EncryptedFrame = await encryptFrame(key, boxId, JSON.stringify(payload));
    const outer = JSON.stringify({ t: "frame", ...frame, ...(via ? { via } : {}) });
    if (Buffer.byteLength(outer, "utf8") > RELAY_MAX_FRAME_BYTES) return false;
    try {
      ws.send(outer);
      return true;
    } catch {
      return false;
    }
  };

  const sendChunked = async (payload: Record<string, unknown>, via?: string): Promise<boolean> => {
    const parts = splitUtf8(JSON.stringify(payload), RELAY_CHUNK_PLAINTEXT_BYTES);
    if (parts.length === 0 || parts.length > RELAY_MAX_CHUNKS) return false;
    for (let i = 0; i < parts.length; i++) {
      if (
        !(await sendFrame(
          { seq: payload.seq, chunk: i, chunks: parts.length, data: parts[i] },
          via,
        ))
      ) {
        return false;
      }
    }
    return true;
  };

  const sendResponse = async (payload: Record<string, unknown>, via?: string): Promise<void> => {
    if (await sendFrame(payload, via)) return;
    if (await sendChunked(payload, via)) return;
    await sendFrame({ seq: payload.seq, ok: false, error: "response too large to relay" }, via);
  };

  const keepaliveTimer = setInterval(() => {
    void sendFrame({ keepalive: true });
  }, KEEPALIVE_MS);
  keepaliveTimer.unref?.();

  let commandChain: Promise<void> = Promise.resolve();

  const endPermanently = (): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(keepaliveTimer);
    options.onConnectionChange?.("ended");
    options.onPermanentEnd?.();
    try {
      ws?.close(1000, "box ended");
    } catch {
      // already closed
    }
  };

  const onMessage = async (event: MessageEvent): Promise<void> => {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      return;
    }
    if (outer.t === "hello-ok") {
      resolveReady();
      return;
    }
    if (outer.t === "viewer-left" && typeof outer.via === "string") {
      options.onViewerLeft?.(outer.via);
      return;
    }
    if (outer.t === "session-ended") {
      endPermanently();
      return;
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string") {
      return;
    }
    const via = typeof outer.via === "string" ? outer.via : undefined;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(await decryptFrame(key, boxId, { iv: outer.iv, data: outer.data }));
    } catch {
      return;
    }
    const run = commandChain.then(async () => {
      const response = await options.handleCommand(inner, via);
      await sendResponse(response, via);
    });
    commandChain = run.catch(() => {});
    await run;
  };

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.onopen = () => {
      reconnectDelayMs = 2000;
      everConnected = true;
      outageBeganAt = 0;
      socket.send(JSON.stringify({ t: "hello", role: "vm" }));
      options.onConnectionChange?.("connected");
    };
    socket.onmessage = (event) => void onMessage(event);
    socket.onclose = (event) => {
      if (stopped) return;
      const reason = typeof event?.reason === "string" ? event.reason : "";
      if (reason === "session ended" || reason === "box ended") {
        endPermanently();
        return;
      }
      if (everConnected) {
        if (outageBeganAt === 0) outageBeganAt = Date.now();
        if (Date.now() - outageBeganAt > DEAD_BOX_RETRY_EXIT_MS) {
          endPermanently();
          return;
        }
      }
      options.onConnectionChange?.("retrying", `${reconnectDelayMs}`);
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
      reconnectTimer.unref?.();
      reconnectDelayMs = Math.min(30_000, reconnectDelayMs * 2);
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // onclose owns retry behavior
      }
    };
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(keepaliveTimer);
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "goodbye", role: "vm" }));
        // Give the small control frame one event-loop turn to flush.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch {
      // The DO's disconnect grace is the fallback when goodbye is lost.
    }
    try {
      ws?.close(1000, "shutdown");
    } catch {
      // already closed
    }
  };

  connect();
  return { boxId, shareUrl, ready, stop };
}
