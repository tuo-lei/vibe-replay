import { cachedReplaySummary } from "./server-source-catalog.js";
import { providerSessionKey, providerSlugKey } from "./server-enrichment.js";
import type { ReplaySummary } from "./server-types.js";
import type { SessionInfo } from "./types.js";

export { cachedReplaySummary };

/** Build provider-scoped replay lookup maps by slug and native session ID. */
export function buildReplayMaps(replays: ReplaySummary[]): {
  bySlug: Map<string, ReplaySummary>;
  bySessionId: Map<string, ReplaySummary>;
  ambiguousSlugs: Set<string>;
} {
  const bySlug = new Map<string, ReplaySummary>();
  const bySessionId = new Map<string, ReplaySummary>();
  const ambiguousSlugs = new Set<string>();
  for (const replay of replays) {
    const targetId = replay.location?.kind === "ssh" ? replay.location.id : undefined;
    const slugKey = providerSlugKey(replay.provider, replay.slug, targetId);
    if (bySlug.has(slugKey)) ambiguousSlugs.add(slugKey);
    else bySlug.set(slugKey, replay);
    if (replay.sessionId) {
      bySessionId.set(providerSessionKey(replay.provider, replay.sessionId, targetId), replay);
    }
  }
  return { bySlug, bySessionId, ambiguousSlugs };
}

export function providerSlugCounts(
  sessions: ReadonlyArray<Pick<SessionInfo, "provider" | "slug" | "location">>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const targetId = session.location?.kind === "ssh" ? session.location.id : undefined;
    const key = providerSlugKey(session.provider, session.slug, targetId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function findReplayForSource(
  source: {
    provider: string;
    sessionId?: string;
    slug: string;
    location?: SessionInfo["location"];
  },
  maps: ReturnType<typeof buildReplayMaps>,
  sourceSlugCounts: ReadonlyMap<string, number>,
): ReplaySummary | undefined {
  const targetId = source.location?.kind === "ssh" ? source.location.id : undefined;
  if (source.sessionId) {
    const bySessionId = maps.bySessionId.get(
      providerSessionKey(source.provider, source.sessionId, targetId),
    );
    if (bySessionId) return bySessionId;
  }

  const slugKey = providerSlugKey(source.provider, source.slug, targetId);
  if (maps.ambiguousSlugs.has(slugKey) || sourceSlugCounts.get(slugKey) !== 1) return undefined;
  return maps.bySlug.get(slugKey);
}
