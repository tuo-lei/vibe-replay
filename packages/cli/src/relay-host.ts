import {
  createRelayTransport,
  type RelayTransportContext,
  type RelayTransportHandle,
} from "./relay-transport.js";

export {
  DEFAULT_RELAY_ORIGIN,
  RELAY_CHUNK_PLAINTEXT_BYTES,
  RELAY_MAX_CHUNKS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_RESPONSE_BYTES,
} from "./relay-transport.js";

export const RELAY_STARTUP_TIMEOUT_MS = 30_000;

export interface RelayHostOptions {
  relayOrigin?: string;
  /** Public page path. WebSocket traffic always goes through /live/:boxId. */
  sharePath?: string;
  handleCommand: (
    message: Record<string, unknown>,
    via?: string,
  ) => Promise<Record<string, unknown>>;
  onViewerLeft?: (via: string) => void;
  onPresenceChange?: (viewers: RelayHostViewer[]) => void;
  onPermanentEnd?: () => void;
  onConnectionChange?: (state: "connected" | "retrying" | "ended", detail?: string) => void;
}

export interface RelayHostHandle {
  boxId: string;
  shareUrl: string;
  /** Resolves once the relay has durably acknowledged the shipper hello. */
  ready: Promise<void>;
  viewers: () => RelayHostViewer[];
  stop: () => Promise<void>;
}

export interface RelayHostViewer {
  id: string;
  name: string;
}

function encryptedPresenceFrame(value: unknown): { iv: string; data: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  return typeof frame.iv === "string" && typeof frame.data === "string"
    ? { iv: frame.iv, data: frame.data }
    : null;
}

/**
 * Product wrapper around the shared relay transport for single-replay Quick
 * Share. It owns only the decrypted viewer roster; connection/crypto/chunking
 * and command routing live in relay-transport.ts.
 */
export async function createRelayHost(options: RelayHostOptions): Promise<RelayHostHandle> {
  const viewerPresence = new Map<string, string>();

  const snapshotViewers = (): RelayHostViewer[] =>
    [...viewerPresence.entries()].map(([id, name]) => ({ id, name }));

  const emitPresence = (): void => options.onPresenceChange?.(snapshotViewers());

  const decryptViewerName = async (
    value: unknown,
    context: RelayTransportContext,
  ): Promise<string> => {
    const frame = encryptedPresenceFrame(value);
    if (!frame) return "Guest";
    try {
      const name = await context.decrypt(frame);
      return (
        name
          .replace(/\p{Cc}/gu, "")
          .trim()
          .slice(0, 32) || "Guest"
      );
    } catch {
      return "Guest";
    }
  };

  const onControl = async (
    message: Record<string, unknown>,
    context: RelayTransportContext,
  ): Promise<void> => {
    if (message.t === "hello-ok") {
      if (!Array.isArray(message.presence)) return;
      const nextPresence = new Map<string, string>();
      for (const item of message.presence) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.vid !== "string") continue;
        nextPresence.set(record.vid.slice(0, 64), await decryptViewerName(record.name, context));
      }
      viewerPresence.clear();
      for (const [id, name] of nextPresence) viewerPresence.set(id, name);
      emitPresence();
      return;
    }

    if (message.t === "viewer-joined" && typeof message.via === "string") {
      viewerPresence.set(message.via.slice(0, 64), await decryptViewerName(message.name, context));
      emitPresence();
      return;
    }

    if (message.t === "viewer-left" && typeof message.via === "string") {
      viewerPresence.delete(message.via);
      emitPresence();
      options.onViewerLeft?.(message.via);
    }
  };

  const transport: RelayTransportHandle = await createRelayTransport({
    relayOrigin: options.relayOrigin,
    sharePath: options.sharePath,
    startupTimeoutMs: RELAY_STARTUP_TIMEOUT_MS,
    handleCommand: options.handleCommand,
    onControl,
    onPermanentEnd: () => options.onPermanentEnd?.(),
    onConnectionChange: options.onConnectionChange,
  });

  return {
    boxId: transport.boxId,
    shareUrl: transport.shareUrl,
    ready: transport.ready,
    viewers: snapshotViewers,
    stop: transport.stop,
  };
}
