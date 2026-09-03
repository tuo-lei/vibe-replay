import { homedir } from "node:os";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getProvider } from "../providers/index.js";
import {
  loadRemoteSourceConfigs,
  normalizeRemoteSourceConfig,
  saveRemoteSourceConfigs,
  testRemoteSourceConnection,
  type RemoteSourceConfig,
} from "../remote.js";
import { mergeSameSessions } from "../session-merge.js";
import { enrichmentHintsFromBody, type EnrichmentHints } from "../server-enrichment.js";
import { getErrorMessage } from "../server-core.js";
import type {
  NormalizedSourceSessionCatalogCache,
  SourceSessionCatalogCache,
  SourceSummaryRecord,
} from "../server-types.js";
import type { SafeProviderDiscoveryResult } from "../provider-discovery.js";
import type { SessionInfo } from "../types.js";

interface SourcesEnrichmentStatus {
  running: boolean;
  processed: number;
  total: number;
  updated: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

function parseRemoteSourcesSettingsBody(
  body: unknown,
): { sources: RemoteSourceConfig[] } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be an object" };
  }
  const rawSources = (body as { remoteSources?: unknown }).remoteSources;
  if (!Array.isArray(rawSources)) {
    return { error: "remoteSources must be an array" };
  }
  if (rawSources.length > 32) {
    return { error: "At most 32 SSH sources can be configured" };
  }

  const sources: RemoteSourceConfig[] = [];
  const ids = new Set<string>();
  for (const rawSource of rawSources) {
    const source = normalizeRemoteSourceConfig(rawSource);
    if (!source) return { error: "Each SSH source must have a valid id and sshHost" };
    if (ids.has(source.id)) return { error: `Duplicate SSH source id: ${source.id}` };
    ids.add(source.id);
    sources.push(source);
  }
  return { sources };
}

interface SourcesRouteDeps {
  baseDir: string;
  cleanupPeriodDays: number;
  readSourcesCatalogCache: () => Promise<NormalizedSourceSessionCatalogCache | null>;
  writeDiscoveredSourcesCatalog: (
    sessions: SourceSummaryRecord[],
    previous?: NormalizedSourceSessionCatalogCache | null,
    failedProviders?: string[],
  ) => Promise<SourceSessionCatalogCache>;
  getStaleSourceProviders: (
    cached: NormalizedSourceSessionCatalogCache | null,
  ) => Promise<string[]>;
  discoverAllProviders: (
    subscriber?: (session: SessionInfo) => Promise<void> | void,
  ) => Promise<SafeProviderDiscoveryResult>;
  buildSourcesResult: (
    merged: SessionInfo[],
    baseDir: string,
    home: string,
    previousSources: SourceSummaryRecord[],
    cleanupPeriodDays: number,
  ) => Promise<SourceSummaryRecord[]>;
  normalizeSessionProjectsForHome: (sessions: SessionInfo[], home: string) => SessionInfo[];
  enrichCursorStatsInBackground: (
    merged: SessionInfo[],
    baseSources: SourceSummaryRecord[],
    hints?: EnrichmentHints,
  ) => void;
  getSourcesEnrichmentStatus: () => SourcesEnrichmentStatus;
  getLastDiscoveredMergedSessions: () => SessionInfo[];
  setLastDiscoveredMergedSessions: (sessions: SessionInfo[]) => void;
  getLatestSourceFailures: () => string[] | undefined;
  setLatestSourceFailures: (failures: string[]) => void;
  getRemoteConfigChangedAt: () => number | undefined;
  setRemoteConfigChangedAt: (value: number) => void;
  requestBackgroundScan: (hints?: EnrichmentHints) => boolean;
  isSameOriginSettingsRequest: (c: Context) => boolean;
}

/** Source discovery, enrichment, and SSH settings routes. */
export function registerSourceRoutes(app: Hono, deps: SourcesRouteDeps): void {
  const {
    baseDir,
    cleanupPeriodDays,
    readSourcesCatalogCache,
    writeDiscoveredSourcesCatalog,
    getStaleSourceProviders,
    discoverAllProviders,
    buildSourcesResult,
    normalizeSessionProjectsForHome,
    enrichCursorStatsInBackground,
    getSourcesEnrichmentStatus,
    getLastDiscoveredMergedSessions,
    setLastDiscoveredMergedSessions,
    getLatestSourceFailures,
    setLatestSourceFailures,
    getRemoteConfigChangedAt,
    setRemoteConfigChangedAt,
    requestBackgroundScan,
    isSameOriginSettingsRequest,
  } = deps;

  const getCachedSourceSessions = async (c: Context) => {
    const cached = await readSourcesCatalogCache();
    const remoteSources = await loadRemoteSourceConfigs();
    const staleProviders = await getStaleSourceProviders(cached);
    const failedProviders = getLatestSourceFailures() ?? cached?.failedProviders ?? [];
    const discoveredAtMs = cached?.discoveredAt ? Date.parse(cached.discoveredAt) : Number.NaN;
    const remoteConfigChangedAt = getRemoteConfigChangedAt();
    const configStale =
      remoteConfigChangedAt !== undefined &&
      (!Number.isFinite(discoveredAtMs) || discoveredAtMs < remoteConfigChangedAt);
    const allStaleProviders = [
      ...new Set([...staleProviders, ...failedProviders, ...(configStale ? ["ssh-config"] : [])]),
    ];
    return c.json({
      sessions: cached?.sessions || [],
      cachedAt: cached?.cachedAt,
      discoveredAt: cached?.discoveredAt,
      remoteSources,
      stale: allStaleProviders.length > 0,
      staleProviders: allStaleProviders,
      failedProviders,
    });
  };

  app.get("/api/sources/cached", getCachedSourceSessions);
  app.get("/api/source-sessions/cached", getCachedSourceSessions);

  const getSourceSessionsEnrichmentStatus = async (c: Context) => {
    return c.json(getSourcesEnrichmentStatus());
  };

  app.get("/api/sources/enrichment-status", getSourceSessionsEnrichmentStatus);
  app.get("/api/source-sessions/enrichment-status", getSourceSessionsEnrichmentStatus);

  const postSourceSessionsEnrich = async (c: Context) => {
    const hints = enrichmentHintsFromBody(await c.req.json().catch(() => undefined));
    const cached = await readSourcesCatalogCache();
    if (!cached?.sessions.length) {
      return c.json({ ok: false, message: "No sources cache available" }, 404);
    }
    const cursorProvider = getProvider("cursor");
    if (!cursorProvider) return c.json({ ok: false, message: "Cursor provider unavailable" }, 404);

    const home = homedir();
    let cursorSessions = getLastDiscoveredMergedSessions().filter(
      (session) => session.provider === "cursor",
    );
    if (cursorSessions.length === 0) {
      cursorSessions = normalizeSessionProjectsForHome(
        mergeSameSessions(await cursorProvider.discover()),
        home,
      );
      setLastDiscoveredMergedSessions([
        ...getLastDiscoveredMergedSessions().filter((session) => session.provider !== "cursor"),
        ...cursorSessions,
      ]);
    }
    const wasRunning = getSourcesEnrichmentStatus().running;
    enrichCursorStatsInBackground(cursorSessions, cached.sessions, hints);
    return c.json({
      ok: true,
      running: getSourcesEnrichmentStatus().running,
      queued: wasRunning,
    });
  };

  app.post("/api/sources/enrich", postSourceSessionsEnrich);
  app.post("/api/source-sessions/enrich", postSourceSessionsEnrich);

  const getSourceSessions = async (c: Context) => {
    try {
      const discovery = await discoverAllProviders();
      setLatestSourceFailures(discovery.failedProviders);
      const merged = mergeSameSessions(discovery.sessions);
      setLastDiscoveredMergedSessions(normalizeSessionProjectsForHome(merged, homedir()));
      const previous = await readSourcesCatalogCache();
      const result = await buildSourcesResult(
        merged,
        baseDir,
        homedir(),
        previous?.sessions || [],
        cleanupPeriodDays,
      );

      const catalog = await writeDiscoveredSourcesCatalog(
        result,
        previous,
        discovery.failedProviders,
      );
      enrichCursorStatsInBackground(merged, result);
      const remoteSources = await loadRemoteSourceConfigs();
      return c.json({
        sessions: catalog.sessions,
        cleanupPeriodDays,
        discoveredAt: catalog.discoveredAt,
        remoteSources,
        stale: discovery.failedProviders.length > 0,
        staleProviders: discovery.failedProviders,
        failedProviders: discovery.failedProviders,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  };

  app.get("/api/sources", getSourceSessions);
  app.get("/api/source-sessions", getSourceSessions);

  app.get("/api/settings", async (c) => {
    try {
      return c.json({ remoteSources: await loadRemoteSourceConfigs() });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.put("/api/settings/remote-sources", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ error: "Settings requests must be same-origin" }, 403);
    }
    const parsed = parseRemoteSourcesSettingsBody(await c.req.json().catch(() => undefined));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    try {
      await saveRemoteSourceConfigs(parsed.sources);
      setRemoteConfigChangedAt(Date.now());
      const queued = requestBackgroundScan();
      return c.json({ ok: true, queued, remoteSources: parsed.sources });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.post("/api/settings/remote-sources/test", async (c) => {
    if (!isSameOriginSettingsRequest(c)) {
      return c.json({ ok: false, message: "Settings requests must be same-origin" }, 403);
    }
    const body = await c.req.json().catch(() => undefined);
    const value =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { remoteSource?: unknown }).remoteSource
        : undefined;
    return c.json(await testRemoteSourceConnection(value));
  });

  const streamSourceSessions = (c: Context) => {
    return streamSSE(c, async (stream) => {
      try {
        let scanned = 0;
        const discovery = await discoverAllProviders(async () => {
          scanned++;
          if (scanned % 5 === 0 || scanned === 1) {
            await stream.writeSSE({
              data: JSON.stringify({ type: "progress", scanned }),
            });
          }
        });
        setLatestSourceFailures(discovery.failedProviders);

        const merged = mergeSameSessions(discovery.sessions);
        setLastDiscoveredMergedSessions(normalizeSessionProjectsForHome(merged, homedir()));
        const previous = await readSourcesCatalogCache();
        const result = await buildSourcesResult(
          merged,
          baseDir,
          homedir(),
          previous?.sessions || [],
          cleanupPeriodDays,
        );

        const catalog = await writeDiscoveredSourcesCatalog(
          result,
          previous,
          discovery.failedProviders,
        );
        enrichCursorStatsInBackground(merged, result);
        const remoteSources = await loadRemoteSourceConfigs();
        await stream.writeSSE({
          data: JSON.stringify({
            type: "complete",
            sessions: catalog.sessions,
            cleanupPeriodDays,
            discoveredAt: catalog.discoveredAt,
            remoteSources,
            stale: discovery.failedProviders.length > 0,
            staleProviders: discovery.failedProviders,
            failedProviders: discovery.failedProviders,
          }),
        });
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message: getErrorMessage(err) }),
        });
      }
    });
  };

  app.get("/api/sources/stream", streamSourceSessions);
  app.get("/api/source-sessions/stream", streamSourceSessions);
}
