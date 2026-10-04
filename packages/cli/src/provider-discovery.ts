import { SqliteSnapshotRequiredError } from "@vibe-replay/provider-core/utils";
import type { Provider, SessionInfo } from "@vibe-replay/provider-contract";
import { deduplicateSessionsByProvider } from "./providers/index.js";
import { discoverConfiguredRemoteSessions } from "./remote.js";

export interface ProviderDiscoveryCoverage {
  provider: string;
  status: "ready" | "empty" | "failed";
  sessionCount: number;
  errorCode?: "schema-incompatible" | "read-failed" | "checkpoint-required";
  message?: string;
}

export interface SafeProviderDiscoveryResult {
  sessions: SessionInfo[];
  failedProviders: string[];
  coverage: ProviderDiscoveryCoverage[];
}

/**
 * Discover providers independently so one upstream schema or filesystem failure
 * cannot hide healthy providers. Results use the same cross-provider priority
 * contract as the CLI picker.
 */
export async function discoverProvidersSafely(
  providers: Provider[],
  onSession?: (session: SessionInfo) => Promise<void> | void,
  options?: { readOnly?: boolean },
): Promise<SafeProviderDiscoveryResult> {
  const allSessions: SessionInfo[] = [];
  const failedProviders: string[] = [];
  const coverage: ProviderDiscoveryCoverage[] = [];
  // SSH discovery is independent from local provider reads. Starting it now
  // hides the connection latency behind Cursor/local filesystem discovery.
  const remotePromise = discoverConfiguredRemoteSessions(
    providers.map((provider) => provider.name),
    { readOnly: options?.readOnly },
  ).catch((error) => {
    if (process.env.VIBE_REPLAY_DEBUG) {
      console.error("[vibe-replay] configured SSH discovery failed:", error);
    }
    return { sessions: [], failedTargets: ["unknown"] };
  });

  for (const provider of providers) {
    let sessions: SessionInfo[];
    let failed = false;
    try {
      sessions = options?.readOnly
        ? await provider.discover({ readOnly: true })
        : await provider.discover();
    } catch (error) {
      failed = true;
      failedProviders.push(provider.name);
      const checkpointError = error instanceof SqliteSnapshotRequiredError;
      const schemaError =
        error instanceof Error &&
        /no such (?:table|column)|unsupported.*schema/i.test(error.message);
      sessions = checkpointError ? error.sessions : [];
      coverage.push({
        provider: provider.name,
        status: "failed",
        sessionCount: sessions.length,
        errorCode: checkpointError
          ? "checkpoint-required"
          : schemaError
            ? "schema-incompatible"
            : "read-failed",
        message: checkpointError
          ? "Read-only workflows require a checkpointed database. Checkpoint in the source application or use a saved replay."
          : schemaError
            ? "The installed provider storage format is incompatible. Update Vibe Replay or report the schema mismatch."
            : "Provider discovery failed. Run with VIBE_REPLAY_DEBUG=1 for local diagnostics.",
      });
      if (process.env.VIBE_REPLAY_DEBUG) {
        console.error(`[vibe-replay] ${provider.name} discovery failed:`, error);
      }
    }
    if (!failed)
      coverage.push({
        provider: provider.name,
        status: sessions.length ? "ready" : "empty",
        sessionCount: sessions.length,
      });
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
  coverage.push(
    ...remote.failedTargets.map((id) => ({
      provider: `ssh:${id}`,
      status: "failed" as const,
      sessionCount: 0,
      errorCode: "read-failed" as const,
      message: "SSH source unavailable. Check the configured host and permissions.",
    })),
  );

  return {
    sessions: deduplicateSessionsByProvider(allSessions),
    failedProviders,
    coverage,
  };
}
