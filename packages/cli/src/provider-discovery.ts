import type { Provider, SessionInfo } from "@vibe-replay/provider-contract";
import { deduplicateSessionsByProvider } from "./providers/index.js";
import { discoverConfiguredRemoteSessions } from "./remote.js";

export interface SafeProviderDiscoveryResult {
  sessions: SessionInfo[];
  failedProviders: string[];
}

/**
 * Discover providers independently so one upstream schema or filesystem failure
 * cannot hide healthy providers. Results use the same cross-provider priority
 * contract as the CLI picker.
 */
export async function discoverProvidersSafely(
  providers: Provider[],
  onSession?: (session: SessionInfo) => Promise<void> | void,
): Promise<SafeProviderDiscoveryResult> {
  const allSessions: SessionInfo[] = [];
  const failedProviders: string[] = [];
  // SSH discovery is independent from local provider reads. Starting it now
  // hides the connection latency behind Cursor/local filesystem discovery.
  const remotePromise = discoverConfiguredRemoteSessions(
    providers.map((provider) => provider.name),
  );

  for (const provider of providers) {
    let sessions: SessionInfo[];
    try {
      sessions = await provider.discover();
    } catch (error) {
      failedProviders.push(provider.name);
      if (process.env.VIBE_REPLAY_DEBUG) {
        console.error(`[vibe-replay] ${provider.name} discovery failed:`, error);
      }
      continue;
    }
    for (const session of sessions) {
      allSessions.push(session);
      await onSession?.(session);
    }
  }

  const remote = await remotePromise;
  for (const session of remote.sessions) {
    allSessions.push(session);
    await onSession?.(session);
  }
  failedProviders.push(...remote.failedTargets.map((targetId) => `ssh:${targetId}`));

  return {
    sessions: deduplicateSessionsByProvider(allSessions),
    failedProviders,
  };
}
