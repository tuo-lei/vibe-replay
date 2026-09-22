import {
  decryptFrame as decryptRelayFrame,
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
export const RELAY_DEAD_BOX_RETRY_EXIT_MS = 150_000;
export const RELAY_KEEPALIVE_MS = 45_000;

export interface RelayTransportContext {
  /** Decrypt relay-carried ciphertext that uses this box's content key. */
  decrypt: (frame: EncryptedFrame) => Promise<string>;
}

export interface RelayTransportOptions {
  relayOrigin?: string;
  /** Public page path. WebSocket traffic always goes through /live/:boxId. */
  sharePath?: string;
  handleCommand: (
    message: Record<string, unknown>,
    via?: string,
  ) => Promise<Record<string, unknown>>;
  /** Plaintext relay control frames (hello-ok / viewer join / viewer leave). */
  onControl?: (
    message: Record<string, unknown>,
    context: RelayTransportContext,
  ) => Promise<void> | void;
  onPermanentEnd?: (reason: string) => void;
  onConnectionChange?: (state: "connected" | "retrying" | "ended", detail?: string) => void;
  /** Omit/null to keep retrying initial connection forever. */
  startupTimeoutMs?: number | null;
  /** Time to let the small goodbye control frame flush before closing. */
  goodbyeFlushMs?: number;
}

export interface RelayTransportHandle {
  boxId: string;
  shareUrl: string;
  /** Resolves after the relay durably acknowledges the first shipper hello. */
  ready: Promise<void>;
  /** Send an encrypted push payload, optionally routed to one viewer. */
  sendFrame: (payload: unknown, via?: string) => Promise<boolean>;
  stop: () => Promise<void>;
}

function validateRelayOrigin(origin: string): void {
  const url = new URL(origin);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && loopback) return;
  if (url.protocol === "http:") {
    throw new Error(
      `refusing cleartext relay origin ${origin}: use https (http://localhost is allowed for local testing)`,
    );
  }
  throw new Error(`unsupported relay origin protocol ${url.protocol}: use https`);
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    const bytes = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (currentBytes + bytes > maxBytes && current.length > 0) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Shared E2E shipper transport used by both the multi-session relay CLI and
 * single-replay Quick Share. Product-specific commands and presence policy
 * remain in their callers; this module owns only transport/lifecycle concerns.
 */
export async function createRelayTransport(
  options: RelayTransportOptions,
): Promise<RelayTransportHandle> {
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
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const decrypt = (frame: EncryptedFrame): Promise<string> => decryptRelayFrame(key, boxId, frame);

  const settleReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    resolveReady();
  };

  const failReady = (message: string): void => {
    if (readySettled) return;
    readySettled = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    rejectReady(new Error(message));
  };

  const sendFrame = async (payload: unknown, via?: string): Promise<boolean> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame = await encryptFrame(key, boxId, JSON.stringify(payload));
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
    for (let index = 0; index < parts.length; index++) {
      const sent = await sendFrame(
        { seq: payload.seq, chunk: index, chunks: parts.length, data: parts[index] },
        via,
      );
      if (!sent) return false;
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
  }, RELAY_KEEPALIVE_MS);
  keepaliveTimer.unref?.();

  let commandChain: Promise<void> = Promise.resolve();
  let controlChain: Promise<void> = Promise.resolve();
  const controlContext: RelayTransportContext = { decrypt };

  const queueControl = (message: Record<string, unknown>): Promise<void> => {
    const run = controlChain.then(async () => {
      await options.onControl?.(message, controlContext);
    });
    controlChain = run.catch(() => {});
    return run;
  };

  const endPermanently = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInterval(keepaliveTimer);
    failReady(reason);
    options.onConnectionChange?.("ended", reason);
    try {
      ws?.close(1000, "box ended");
    } catch {
      // already closed
    }
    options.onPermanentEnd?.(reason);
  };

  const onMessage = async (event: MessageEvent): Promise<void> => {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      return;
    }

    if (outer.t === "hello-ok") {
      try {
        await queueControl(outer);
      } catch {
        // A product-specific control callback must not strand transport readiness.
      } finally {
        settleReady();
      }
      return;
    }
    if (outer.t === "viewer-joined" || outer.t === "viewer-left") {
      try {
        await queueControl(outer);
      } catch {
        // Ignore product-level presence errors; the relay connection remains healthy.
      }
      return;
    }
    if (outer.t === "session-ended") {
      endPermanently("relay session ended");
      return;
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string") {
      return;
    }

    const via = typeof outer.via === "string" ? outer.via : undefined;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(await decrypt({ iv: outer.iv, data: outer.data }));
    } catch {
      return;
    }

    const run = commandChain.then(async () => {
      const response = await options.handleCommand(inner, via);
      await sendResponse(response, via);
    });
    commandChain = run.catch(() => {});
    await run.catch(() => {});
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
        endPermanently(`relay ${reason}`);
        return;
      }
      if (everConnected) {
        if (outageBeganAt === 0) outageBeganAt = Date.now();
        if (Date.now() - outageBeganAt > RELAY_DEAD_BOX_RETRY_EXIT_MS) {
          endPermanently(
            `relay unreachable for ${Math.round((Date.now() - outageBeganAt) / 1000)}s`,
          );
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
    failReady("relay transport stopped before it became ready");
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "goodbye", role: "vm" }));
        const flushMs = options.goodbyeFlushMs ?? 25;
        if (flushMs > 0) await new Promise((resolve) => setTimeout(resolve, flushMs));
      }
    } catch {
      // The relay's disconnect grace is the fallback when goodbye is lost.
    }
    try {
      ws?.close(1000, "shutdown");
    } catch {
      // already closed
    }
  };

  if (options.startupTimeoutMs != null) {
    startupTimer = setTimeout(
      () => endPermanently(`relay did not become ready within ${options.startupTimeoutMs}ms`),
      options.startupTimeoutMs,
    );
    startupTimer.unref?.();
  }
  connect();

  return { boxId, shareUrl, ready, sendFrame, stop };
}
