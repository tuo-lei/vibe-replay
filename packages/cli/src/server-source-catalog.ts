/**
 * Source-session catalog cache helpers: building, normalizing, merging, and
 * freshness-probing the dashboard's materialized cache of source-session
 * summaries. Extracted from server.ts (no server state lives here).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileCacheEntry } from "./cache.js";
import { getPiSessionsDir } from "./providers/pi/config.js";
import { sourceSessionKey } from "./server-enrichment.js";
import type {
  CachedSourceRecord,
  NormalizedSourceSessionCatalogCache,
  ProviderDiscoveryState,
  SourceProviderFreshnessProbe,
  SourceSessionCatalogCache,
  SourceSummaryRecord,
} from "./server-types.js";

export function isSourceSessionCatalogCache(value: unknown): value is SourceSessionCatalogCache {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { discoveredAt?: unknown }).discoveredAt === "string" &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  );
}

export function normalizeSourceSessionCatalogCache(
  cached: FileCacheEntry<SourceSessionCatalogCache | CachedSourceRecord[]> | null,
): NormalizedSourceSessionCatalogCache | null {
  if (!cached) return null;
  if (Array.isArray(cached.data)) {
    return {
      sessions: cached.data,
      cachedAt: cached.updatedAt,
      discoveredAt: cached.updatedAt,
      updatedAt: cached.updatedAt,
      legacy: true,
    };
  }
  if (isSourceSessionCatalogCache(cached.data)) {
    return {
      sessions: cached.data.sessions,
      cachedAt: cached.updatedAt,
      discoveredAt: cached.data.discoveredAt || cached.updatedAt,
      updatedAt: cached.data.updatedAt || cached.updatedAt,
      providerStates: cached.data.providerStates,
      legacy: false,
    };
  }
  return null;
}

export function buildProviderDiscoveryStates(
  sources: SourceSummaryRecord[],
  discoveredAt: string,
): Record<string, ProviderDiscoveryState> {
  const byProvider = new Map<string, SourceSummaryRecord[]>();
  for (const source of sources) {
    const bucket = byProvider.get(source.provider) || [];
    bucket.push(source);
    byProvider.set(source.provider, bucket);
  }

  const states: Record<string, ProviderDiscoveryState> = {};
  for (const [provider, providerSources] of byProvider) {
    states[provider] = {
      provider,
      discoveredAt,
      sessionCount: providerSources.length,
    };
  }
  return states;
}

export function buildSourceSessionCatalogCache(
  sessions: SourceSummaryRecord[],
  discoveredAt: string,
  previous?: NormalizedSourceSessionCatalogCache | null,
): SourceSessionCatalogCache {
  const providerStates = {
    ...previous?.providerStates,
    ...buildProviderDiscoveryStates(sessions, discoveredAt),
  };
  return {
    schemaVersion: 1,
    discoveredAt,
    updatedAt: discoveredAt,
    providerStates,
    sessions: sessions as CachedSourceRecord[],
  };
}

export async function probeSourceRecordsFreshness(
  sources: SourceSummaryRecord[],
  provider: string,
): Promise<SourceProviderFreshnessProbe> {
  const probe: SourceProviderFreshnessProbe = {
    provider,
    // This probe works from a flat list of source filePaths rather than a
    // directory tree, so there is no real root to report — reuse the provider
    // name as the label. (walkJsonlFreshness, by contrast, sets a real path.)
    sessionsRoot: provider,
    fileCount: 0,
  };

  const paths = new Set(
    sources
      .filter((source) => source.provider === provider)
      .flatMap((source) => source.filePaths || [])
      .filter(
        (filePath): filePath is string => typeof filePath === "string" && filePath.length > 0,
      ),
  );

  for (const filePath of paths) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) continue;
    probe.fileCount += 1;
    if (probe.newestSourceMtimeMs == null || fileStat.mtimeMs > probe.newestSourceMtimeMs) {
      probe.newestSourceMtimeMs = fileStat.mtimeMs;
      probe.newestSourcePath = filePath;
    }
  }

  return probe;
}

export function mergeSourceCatalogSessionUpdates(
  current: CachedSourceRecord[],
  updates: CachedSourceRecord[],
): CachedSourceRecord[] {
  if (current.length === 0) return updates;

  const bySessionId = new Map<string, CachedSourceRecord>();
  const byKey = new Map<string, CachedSourceRecord>();
  for (const update of updates) {
    byKey.set(sourceSessionKey(update.provider, update.project, update.slug), update);
    if (typeof update.sessionId === "string" && update.sessionId) {
      bySessionId.set(update.sessionId, update);
    }
  }

  return current.map((session) => {
    const byId = session.sessionId ? bySessionId.get(session.sessionId) : undefined;
    const update =
      (byId?.provider === session.provider ? byId : undefined) ??
      byKey.get(sourceSessionKey(session.provider, session.project, session.slug));
    return update ? { ...session, ...update } : session;
  });
}

export function updateSourceSessionCatalogSessions(
  catalog: NormalizedSourceSessionCatalogCache,
  sessions: CachedSourceRecord[],
  updatedAt = new Date().toISOString(),
): SourceSessionCatalogCache {
  return {
    schemaVersion: 1,
    discoveredAt: catalog.discoveredAt || catalog.cachedAt || updatedAt,
    updatedAt,
    providerStates: catalog.providerStates,
    sessions,
  };
}

export async function walkJsonlFreshness(
  root: string,
  provider: string,
): Promise<SourceProviderFreshnessProbe> {
  const probe: SourceProviderFreshnessProbe = {
    provider,
    sessionsRoot: root,
    fileCount: 0,
  };

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory missing or unreadable — nothing to probe under it.
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
        const fileStat = await stat(entryPath).catch(() => null);
        if (!fileStat) return;
        probe.fileCount += 1;
        if (probe.newestSourceMtimeMs == null || fileStat.mtimeMs > probe.newestSourceMtimeMs) {
          probe.newestSourceMtimeMs = fileStat.mtimeMs;
          probe.newestSourcePath = entryPath;
        }
      }),
    );
  }

  await walk(root);
  return probe;
}

export async function probePiSourceFreshness(): Promise<SourceProviderFreshnessProbe> {
  return walkJsonlFreshness(getPiSessionsDir(), "pi");
}

export function sourceProviderFingerprint(probe: SourceProviderFreshnessProbe): string {
  return `${probe.fileCount}:${probe.newestSourcePath || ""}`;
}

export async function getStaleSourceProviders(
  catalog: NormalizedSourceSessionCatalogCache | null,
): Promise<string[]> {
  if (!catalog) return [];
  const staleProviders: string[] = [];
  const piProbe = await probePiSourceFreshness();
  const piFingerprint = sourceProviderFingerprint(piProbe);
  const previousPiFingerprint = catalog.providerStates?.pi?.fingerprint;
  const previousPiSessionCount = catalog.providerStates?.pi?.sessionCount;
  const cachedPiSessionCount = catalog.sessions.filter(
    (session) => session.provider === "pi",
  ).length;
  if (
    cachedPiSessionCount > 0 &&
    typeof previousPiSessionCount === "number" &&
    previousPiSessionCount !== cachedPiSessionCount
  ) {
    staleProviders.push("pi");
  }
  if (previousPiFingerprint) {
    if (piFingerprint !== previousPiFingerprint) staleProviders.push("pi");
    return [...new Set(staleProviders)];
  }

  const piDiscoveredAt =
    catalog.providerStates?.pi?.discoveredAt || catalog.discoveredAt || catalog.cachedAt;
  const piDiscoveredMs = piDiscoveredAt ? Date.parse(piDiscoveredAt) : Number.NaN;
  if (
    piProbe.fileCount > 0 &&
    piProbe.newestSourceMtimeMs != null &&
    (catalog.legacy ||
      !Number.isFinite(piDiscoveredMs) ||
      piProbe.newestSourceMtimeMs > piDiscoveredMs)
  ) {
    staleProviders.push("pi");
  }
  return [...new Set(staleProviders)];
}
