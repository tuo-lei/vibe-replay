import type { SessionInfo } from "@vibe-replay/provider-contract";
import type { SourceProviderProgress } from "@vibe-replay/types";
import type { SafeProviderDiscoveryResult } from "./provider-discovery.js";

type SessionSubscriber = (session: SessionInfo) => Promise<void> | void;
type ProviderSubscriber = (state: SourceProviderProgress) => Promise<void> | void;

/** Share ongoing discovery and replay provider states to dashboards that join a scanner run. */
export function createSharedProviderDiscovery(
  discover: (
    onSession: SessionSubscriber,
    onProvider: ProviderSubscriber,
  ) => Promise<SafeProviderDiscoveryResult>,
) {
  let active: {
    promise: Promise<SafeProviderDiscoveryResult>;
    sessions: Set<SessionSubscriber>;
    providers: Map<ProviderSubscriber, Promise<void>>;
    states: Map<string, SourceProviderProgress>;
  } | null = null;
  return (onSession?: SessionSubscriber, onProvider?: ProviderSubscriber) => {
    let run = active;
    if (!run) {
      const sessions = new Set<SessionSubscriber>();
      const providers = new Map<ProviderSubscriber, Promise<void>>();
      const states = new Map<string, SourceProviderProgress>();
      // Schedule discovery after subscribers are registered, including synchronous producers.
      const promise = Promise.resolve()
        .then(() =>
          discover(
            async (session) => {
              await Promise.all(
                [...sessions].map(async (listener) => {
                  try {
                    await listener(session);
                  } catch {
                    /* Disconnected dashboard. */
                  }
                }),
              );
            },
            async (state) => {
              states.set(state.provider, state);
              await Promise.all(
                [...providers.keys()].map((listener) => enqueue(providers, listener, state)),
              );
            },
          ),
        )
        .finally(() => {
          if (active?.promise === promise) active = null;
        });
      run = { promise, sessions, providers, states };
      active = run;
    }
    if (onSession) run.sessions.add(onSession);
    if (onProvider) {
      run.providers.set(onProvider, Promise.resolve());
      for (const state of run.states.values()) enqueue(run.providers, onProvider, state);
    }
    const joined = run;
    return joined.promise
      .then(async (result) => {
        if (onProvider) await joined.providers.get(onProvider);
        return result;
      })
      .finally(() => {
        if (onSession) joined.sessions.delete(onSession);
        if (onProvider) joined.providers.delete(onProvider);
      });
  };
}

function enqueue(
  queues: Map<ProviderSubscriber, Promise<void>>,
  listener: ProviderSubscriber,
  state: SourceProviderProgress,
): Promise<void> {
  const next = (queues.get(listener) ?? Promise.resolve()).then(async () => {
    try {
      await listener(state);
    } catch {
      /* Progress must not abort shared discovery. */
    }
  });
  queues.set(listener, next);
  return next;
}
