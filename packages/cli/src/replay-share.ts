import type { ReplaySession } from "./types.js";
import { createRelayHost, DEFAULT_RELAY_ORIGIN, type RelayHostHandle } from "./relay-host.js";

/**
 * Product-level cap for ephemeral replay sharing. The relay protocol can
 * chunk larger responses, but keeping Quick Share aligned with Cloud/Gist's
 * 10 MiB limit gives encryption/envelope overhead plenty of headroom and
 * fails before a viewer waits on an impossible transfer.
 */
export const QUICK_SHARE_MAX_BYTES = 10 * 1024 * 1024;

export class QuickShareTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes = QUICK_SHARE_MAX_BYTES,
  ) {
    super(
      `Replay too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Max 10MB for Quick Share.`,
    );
    this.name = "QuickShareTooLargeError";
  }
}

export interface QuickReplayShare {
  url: string;
  boxId: string;
  sizeBytes: number;
  maxBytes: number;
  stop: () => Promise<void>;
}

export async function createQuickReplayShare(
  replay: ReplaySession,
  options: { relayOrigin?: string; onEnded?: () => void } = {},
): Promise<QuickReplayShare> {
  const serialized = JSON.stringify(replay);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes > QUICK_SHARE_MAX_BYTES) {
    throw new QuickShareTooLargeError(sizeBytes);
  }

  const host: RelayHostHandle = await createRelayHost({
    relayOrigin: options.relayOrigin ?? process.env.VIBE_REPLAY_API_URL ?? DEFAULT_RELAY_ORIGIN,
    sharePath: "share",
    onPermanentEnd: options.onEnded,
    handleCommand: async (message) => {
      const { seq, cmd } = message;
      if (cmd === "ping") return { seq, ok: true, data: { t: Date.now() } };
      if (cmd === "get-replay") {
        return { seq, ok: true, data: { replay } };
      }
      return { seq, ok: false, error: `unknown command: ${String(cmd)}` };
    },
  });
  await host.ready;

  return {
    url: host.shareUrl,
    boxId: host.boxId,
    sizeBytes,
    maxBytes: QUICK_SHARE_MAX_BYTES,
    stop: host.stop,
  };
}
