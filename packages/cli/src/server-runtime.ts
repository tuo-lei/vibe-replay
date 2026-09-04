import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import chalk from "chalk";
import { Hono } from "hono";
import open from "open";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { classifyProject } from "@vibe-replay/types";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText, previewPrompt } from "./clean-prompt.js";
import { getClaudeCodeCleanupPeriod } from "./cleanup-warning.js";
import { getAiRuntime } from "./ai-runtime.js";
import { injectDataScript, loadViewerHtml } from "./generator.js";
import { mergeInsights, readInsightsStore, writeInsightsStore } from "./insights.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import { discoverProvidersSafely, type SafeProviderDiscoveryResult } from "./provider-discovery.js";
import { getApiUrl } from "./publishers/cloud.js";
import { mergeSameSessions } from "./session-merge.js";
import { getRemoteHome } from "./remote.js";
import {
  type EnrichmentHints,
  mergeEnrichmentHints,
  pickSourceRecordForSession,
  providerSessionKey,
  preserveFailedProviderScanResults,
  prioritizeScanInputs,
  selectCursorEnrichmentCandidates,
  sourceSessionKey,
} from "./server-enrichment.js";
import {
  buildSourceSessionCatalogCache,
  cachedReplaySummary,
  cachedReplaySummaryChanged,
  getStaleSourceProviders,
  mergeSourceCatalogSessionUpdates,
  normalizeSourceSessionCatalogCache,
  probeSourceRecordsFreshness,
  sourceProviderFingerprint,
  updateSourceSessionCatalogSessions,
} from "./server-source-catalog.js";
import type {
  CachedSourceRecord,
  NormalizedSourceSessionCatalogCache,
  ReplaySummary,
  SourceSessionCatalogCache,
  SourceSummaryRecord,
} from "./server-types.js";
import { createAuthSession } from "./server-auth.js";
import {
  buildSourcesResult,
  isFilesystemProjectKey,
  loadSessionFromDisk,
  normalizeSessionProjectsForHome,
  scanSessions,
} from "./server-replay-catalog.js";
import {
  buildReplayMaps,
  findReplayForSource,
  providerSlugCounts,
} from "./server-replay-matching.js";
import { countSessionStats, extractPromptPreviewsFromTurns } from "./server-session-stats.js";
import { registerArchiveRoutes } from "./server-routes/archive.js";
import { registerAssistantRoutes } from "./server-routes/assistant.js";
import { registerAuthRoutes } from "./server-routes/auth.js";
import { registerAiRoutes } from "./server-routes/ai.js";
import { registerCloudProxyRoutes } from "./server-routes/cloud.js";
import { registerGenerationRoutes } from "./server-routes/generation.js";
import { registerInsightsRoutes } from "./server-routes/insights.js";
import { registerLiveRoutes } from "./server-routes/live.js";
import { registerReplayRoutes } from "./server-routes/replays.js";
import { registerSessionAssetRoutes } from "./server-routes/session-assets.js";
import { registerSessionOutputRoutes } from "./server-routes/session-output.js";
import { registerSourceRoutes } from "./server-routes/sources.js";
import { buildInsightsSyncBatches } from "./server-core.js";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  countPendingCursorUsageIndexes,
  isPartialScanResult,
  type BackgroundScanState,
  type ProjectInsights,
  projectInsightKey,
  readProjectMemory,
  runBackgroundScan,
  type ProjectInsightLocation,
  type ScanInput,
  SCANNER_VERSION,
  type SessionScanResult,
  type UserInsights,
} from "./scanner.js";
import type { SessionInfo } from "./types.js";
import { localDayKey, normalizeTitle } from "./utils.js";

import { isSameOriginSettingsRequest, registerSameOriginMutationGuard } from "./server-origin.js";

interface SourcesEnrichmentStatus {
  running: boolean;
  processed: number;
  total: number;
  updated: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

interface PersistedInsightsCache {
  userInsights: UserInsights | null;
  projectInsights: Array<[string, ProjectInsights]>;
  computedAt: string | null;
}

export async function startServer(
  baseDir: string,
  opts?: {
    openDashboard?: boolean;
    openSlug?: string;
    openTargetId?: string;
    openLive?: { provider: string; sessionId: string };
    externalViewerUrl?: string;
  },
): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const isDevMode = !!opts?.externalViewerUrl;
  // In dev mode, Vite serves the viewer with HMR — no need to load/cache viewer HTML
  const viewerHtml = isDevMode ? "" : await loadViewerHtml();
  // Read once at startup — changes to ~/.claude/settings.json require server restart
  const cleanupPeriodDays = await getClaudeCodeCleanupPeriod();
  const cacheKeySuffix = createHash("sha1").update(baseDir).digest("hex").slice(0, 12);
  // Bumped v2 → v3 after fixing the Cowork sessionId derivation: earlier v2
  // caches stored cliSessionId (inner-subprocess UUID) as the Cowork session's
  // identity, which never matches what the parser reads from audit.jsonl and
  // permanently broke replay-to-source linking. Bumping discards those caches.
  // v3 → v4: added `hasSdk` flag for Cursor SDK-backed sessions; old caches
  // omit the field so the dashboard can't render the SDK badge until refreshed.
  // v4 → v5: Cursor project paths decode differently, so cached entries would
  // keep reporting the old exploded paths as separate projects.
  // v5 → v6: source records carry canonical project identity and corrected
  // Cursor SDK worktree paths.
  // v6 → v7: refine Cursor SDK context-worktree identity grouping.
  // v7 → v8: disambiguate Cursor SDK workflow display labels.
  // v8 → v9: Codex source titles now follow explicit session_index names.
  // v9 → v10: carry provider compaction counts and storage fingerprints.
  const sourcesCacheKey = `dashboard-sources-v10-${cacheKeySuffix}`;
  const replaysCacheKey = `dashboard-replays-v1-${cacheKeySuffix}`;
  // Keyed by scanner version too: a bump changes the shape of what a scan
  // extracts, so serving the previous run's results would show stale facets
  // until the next scan happened to finish.
  const scanResultsCacheKey = `dashboard-scan-results-v${SCANNER_VERSION}-${cacheKeySuffix}`;
  // v5 → v6: project lastActivity now uses session end times when available.
  const insightsCacheKey = `dashboard-insights-v6-${cacheKeySuffix}`;
  const readSourcesCatalogCache = async (): Promise<NormalizedSourceSessionCatalogCache | null> =>
    normalizeSourceSessionCatalogCache(
      await readFileCache<SourceSessionCatalogCache | CachedSourceRecord[]>(sourcesCacheKey),
    );
  const writeDiscoveredSourcesCatalog = async (
    sessions: SourceSummaryRecord[],
    previous?: NormalizedSourceSessionCatalogCache | null,
    failedProviders: string[] = [],
  ): Promise<SourceSessionCatalogCache> => {
    const discoveredAt = new Date().toISOString();
    const catalog = buildSourceSessionCatalogCache(
      sessions,
      discoveredAt,
      previous,
      failedProviders,
    );
    try {
      if (!failedProviders.includes("pi")) {
        const piProbe = await probeSourceRecordsFreshness(sessions, "pi");
        const piSessionCount = sessions.filter((session) => session.provider === "pi").length;
        catalog.providerStates = {
          ...catalog.providerStates,
          pi: {
            ...(catalog.providerStates?.pi || {
              provider: "pi",
              discoveredAt,
            }),
            provider: "pi",
            discoveredAt,
            sessionCount: piSessionCount,
            newestSourceMtimeMs: piProbe.newestSourceMtimeMs,
            newestSourcePath: piProbe.newestSourcePath,
            fingerprint: sourceProviderFingerprint(piProbe),
          },
        };
      }
    } catch {
      // Freshness metadata is best-effort; discovery results are still valid.
    }
    await writeFileCache(sourcesCacheKey, catalog);
    return catalog;
  };
  const writeUpdatedSourcesCatalog = async (
    previous: NormalizedSourceSessionCatalogCache,
    sessions: CachedSourceRecord[],
  ): Promise<void> => {
    await writeFileCache(
      sourcesCacheKey,
      updateSourceSessionCatalogSessions(
        previous,
        mergeSourceCatalogSessionUpdates(previous.sessions, sessions),
      ),
    );
  };
  const refreshReplaysCache = async (): Promise<ReplaySummary[] | null> => {
    try {
      const sessions = await scanSessions(baseDir);
      await writeFileCache(replaysCacheKey, sessions);
      return sessions;
    } catch {
      // Best-effort cache refresh for dashboard listing.
      // Return null (not []) so callers can distinguish "scan failed" from "no replays".
      return null;
    }
  };

  /** After replays change, sync the sources cache so existingReplay / replay stay consistent */
  const syncSourcesCacheWithReplays = async (replays: ReplaySummary[]): Promise<void> => {
    try {
      const cached = await readSourcesCatalogCache();
      if (!cached?.sessions.length) return;

      const replayMaps = buildReplayMaps(replays);
      const sourceSlugCounts = providerSlugCounts(cached.sessions);

      let changed = false;
      const updated = cached.sessions.map((s) => {
        const replay = findReplayForSource(s, replayMaps, sourceSlugCounts);
        const nextReplay = replay ? cachedReplaySummary(replay) : undefined;
        const hadReplay = !!s.existingReplay;
        const hasReplay = !!replay;
        if (
          hadReplay !== hasReplay ||
          (hasReplay &&
            (replay.slug !== s.existingReplay || cachedReplaySummaryChanged(s.replay, nextReplay)))
        ) {
          changed = true;
        }
        return {
          ...s,
          existingReplay: replay ? replay.slug : null,
          replay: nextReplay,
        };
      });

      if (changed) {
        await writeUpdatedSourcesCatalog(cached, updated);
      }
    } catch {
      // Best-effort — never break core flows
    }
  };
  let sourcesEnrichmentStatus: SourcesEnrichmentStatus = {
    running: false,
    processed: 0,
    total: 0,
    updated: 0,
  };
  let pendingSourcesEnrichment: {
    merged: SessionInfo[];
    baseSources: SourceSummaryRecord[];
    hints: EnrichmentHints;
  } | null = null;
  let lastDiscoveredMergedSessions: SessionInfo[] = [];
  let latestSourceFailures: string[] | undefined;
  let remoteConfigChangedAt: number | undefined;
  type DiscoverySubscriber = (session: SessionInfo) => Promise<void> | void;
  let localDiscoveryRun: {
    promise: Promise<SafeProviderDiscoveryResult>;
    subscribers: Set<DiscoverySubscriber>;
  } | null = null;

  /** Share one local/SSH provider discovery across the dashboard and scanner. */
  const discoverAllProviders = (
    subscriber?: DiscoverySubscriber,
  ): Promise<SafeProviderDiscoveryResult> => {
    let run = localDiscoveryRun;
    if (!run) {
      const subscribers = new Set<DiscoverySubscriber>();
      const promise = discoverProvidersSafely(getAllProviders(), async (session) => {
        await Promise.all(
          [...subscribers].map(async (listener) => {
            try {
              await listener(session);
            } catch {
              // A disconnected SSE client must not abort discovery for everyone else.
            }
          }),
        );
      }).finally(() => {
        if (localDiscoveryRun?.promise === promise) localDiscoveryRun = null;
      });
      run = { promise, subscribers };
      localDiscoveryRun = run;
    }

    if (subscriber) run.subscribers.add(subscriber);
    const activeRun = run;
    return activeRun.promise.finally(() => {
      if (subscriber) activeRun.subscribers.delete(subscriber);
    });
  };

  const enrichCursorStatsInBackground = (
    merged: SessionInfo[],
    baseSources: SourceSummaryRecord[],
    hints: EnrichmentHints = {},
  ): void => {
    if (sourcesEnrichmentStatus.running) {
      pendingSourcesEnrichment = {
        merged,
        baseSources,
        hints: mergeEnrichmentHints(pendingSourcesEnrichment?.hints, hints),
      };
      return;
    }
    const cursorProvider = getProvider("cursor");
    if (!cursorProvider) return;

    const candidates = selectCursorEnrichmentCandidates(merged, baseSources, hints);

    sourcesEnrichmentStatus = {
      running: true,
      processed: 0,
      total: candidates.length,
      updated: 0,
      startedAt: new Date().toISOString(),
      message:
        candidates.length > 0
          ? "Computing detailed Cursor stats in background"
          : "No Cursor stat backfill needed",
    };

    if (candidates.length === 0) {
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
      };
      return;
    }

    const enrichedSources = baseSources.map((s) => ({ ...s }));

    void (async () => {
      let changed = false;
      const bySessionId = new Map<string, SourceSummaryRecord>();
      const byKey = new Map<string, SourceSummaryRecord>();
      for (const source of enrichedSources) {
        const targetId = source.location?.kind === "ssh" ? source.location.id : undefined;
        byKey.set(sourceSessionKey(source.provider, source.project, source.slug, targetId), source);
        if (typeof source.sessionId === "string" && source.sessionId) {
          bySessionId.set(providerSessionKey(source.provider, source.sessionId, targetId), source);
        }
      }

      for (const session of candidates) {
        try {
          const paths = [...session.filePaths, ...(session.toolPaths || [])];
          const parsed = await cursorProvider.parse(paths, session);
          const counts = countSessionStats(parsed.turns);
          const promptPreviews = extractPromptPreviewsFromTurns(parsed.turns);
          const enrichedTitle =
            normalizeTitle(cleanPromptText(parsed.title || "")) ||
            normalizeTitle(promptPreviews[0] || "");
          const enrichedFirstPrompt =
            promptPreviews[0] ||
            previewPrompt(parsed.title || "") ||
            previewPrompt(session.firstPrompt);
          const target = pickSourceRecordForSession(session, bySessionId, byKey);
          if (target) {
            let targetChanged = false;
            if (target.promptCount !== counts.promptCount) {
              target.promptCount = counts.promptCount;
              targetChanged = true;
            }
            if (target.toolCallCount !== counts.toolCallCount) {
              target.toolCallCount = counts.toolCallCount;
              targetChanged = true;
            }
            if (typeof enrichedTitle === "string" && target.title !== enrichedTitle) {
              target.title = enrichedTitle;
              targetChanged = true;
            }
            if (enrichedFirstPrompt && target.firstPrompt !== enrichedFirstPrompt) {
              target.firstPrompt = enrichedFirstPrompt;
              targetChanged = true;
            }
            const nextPrompts = promptPreviews.length > 0 ? promptPreviews : undefined;
            if (JSON.stringify(target.prompts) !== JSON.stringify(nextPrompts)) {
              target.prompts = nextPrompts;
              targetChanged = true;
            }
            if (parsed.model && target.model !== parsed.model) {
              target.model = parsed.model;
              targetChanged = true;
            }
            if (parsed.gitBranch && target.gitBranch !== parsed.gitBranch) {
              target.gitBranch = parsed.gitBranch;
              targetChanged = true;
            }
            if (targetChanged) {
              changed = true;
              sourcesEnrichmentStatus = {
                ...sourcesEnrichmentStatus,
                updated: sourcesEnrichmentStatus.updated + 1,
              };
            }
          }
        } catch {
          // Best-effort enrichment only.
        } finally {
          sourcesEnrichmentStatus = {
            ...sourcesEnrichmentStatus,
            processed: sourcesEnrichmentStatus.processed + 1,
          };
          if (changed && sourcesEnrichmentStatus.processed % 5 === 0) {
            const cached = await readSourcesCatalogCache();
            await writeUpdatedSourcesCatalog(
              cached || {
                sessions: baseSources as CachedSourceRecord[],
                discoveredAt: sourcesEnrichmentStatus.startedAt,
                cachedAt: sourcesEnrichmentStatus.startedAt,
              },
              enrichedSources as CachedSourceRecord[],
            );
          }
        }
      }

      if (changed) {
        const cached = await readSourcesCatalogCache();
        await writeUpdatedSourcesCatalog(
          cached || {
            sessions: baseSources as CachedSourceRecord[],
            discoveredAt: sourcesEnrichmentStatus.startedAt,
            cachedAt: sourcesEnrichmentStatus.startedAt,
          },
          enrichedSources as CachedSourceRecord[],
        );
      }
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
      };
      const pending = pendingSourcesEnrichment;
      pendingSourcesEnrichment = null;
      if (pending) {
        enrichCursorStatsInBackground(pending.merged, enrichedSources, pending.hints);
      }
    })().catch(() => {
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
        message: "Cursor stat backfill failed",
      };
      const pending = pendingSourcesEnrichment;
      pendingSourcesEnrichment = null;
      if (pending) {
        enrichCursorStatsInBackground(pending.merged, enrichedSources, pending.hints);
      }
    });
  };

  const persistedScanResults = await readFileCache<SessionScanResult[]>(scanResultsCacheKey);
  const persistedInsights = await readFileCache<PersistedInsightsCache>(insightsCacheKey);

  // ─── Background session scanner state ─────────────────────────────
  let scanState: BackgroundScanState = {
    running: false,
    scanned: persistedScanResults?.data.length || 0,
    total: persistedScanResults?.data.length || 0,
    results: persistedScanResults?.data || [],
    revision: persistedScanResults ? 1 : 0,
    hasSnapshot: persistedScanResults !== null,
    finishedAt: persistedScanResults?.updatedAt,
  };
  // Incremented per scan so a slower follow-up pass can tell it was superseded.
  let scanGeneration = 0;
  let queuedScanHints: EnrichmentHints | undefined;

  // Pre-computed insights cache — populated after each scan completes.
  // Kept across scans (stale-while-refresh): new scan overwrites, never clears.
  let insightsCache: {
    userInsights: UserInsights | null;
    projectInsights: Map<string, ProjectInsights>;
    computedAt: string | null;
  } = persistedInsights?.data
    ? {
        userInsights: persistedInsights.data.userInsights,
        projectInsights: new Map(persistedInsights.data.projectInsights),
        computedAt: persistedInsights.data.computedAt,
      }
    : {
        userInsights: null,
        projectInsights: new Map(),
        computedAt: null,
      };

  /** Persist scan results into the durable local insights store. */
  let insightsPersistChain: Promise<void> = Promise.resolve();
  const persistInsightsFromScan = (results: SessionScanResult[]): Promise<void> => {
    // The fast Cursor pass and its usage backfill complete close together. Keep
    // their read/merge/write cycles ordered or the older, usage-less snapshot
    // can finish last and erase the enriched fields from the durable store.
    const persistableResults = results.filter((result) => !isPartialScanResult(result));
    const job = insightsPersistChain.then(async () => {
      if (persistableResults.length === 0) return;
      const store = await readInsightsStore();
      const updated = mergeInsights(store, persistableResults);
      await writeInsightsStore(updated);
    });
    insightsPersistChain = job.catch(() => {});
    return job;
  };

  /** Track last auto-sync date to avoid syncing more than once per day. */
  let lastAutoSyncDate: string | null = null;

  /** Simple mutex to prevent concurrent sync operations on the insights store. */
  let syncLock: Promise<unknown> = Promise.resolve();

  /**
   * Aggregate local insights by (date, machineId) and push to cloud.
   * Each day becomes one row in cloud — Prometheus-style time series.
   */
  const syncInsightsToCloud = async (): Promise<{
    synced: number;
    total: number;
    error?: string;
  }> => {
    const { aggregateDailyInsights } = await import("./insights.js");
    const {
      loadAuthToken: loadAuth,
      getApiUrl: getUrl,
      getSessionCookieName: getCookie,
    } = await import("./publishers/cloud.js");

    const auth = await loadAuth();
    if (!auth) return { synced: 0, total: 0, error: "Not logged in" };

    const store = await readInsightsStore();
    const daily = aggregateDailyInsights(store);
    if (daily.days.length === 0) return { synced: 0, total: 0 };

    const apiUrl = getUrl();
    const cookieName = getCookie(apiUrl);
    const headers = { "Content-Type": "application/json", Cookie: `${cookieName}=${auth.token}` };
    const today = localDayKey(new Date())!;
    let existingDates = new Set<string>();

    // Delta sync: fetch dates already on cloud, skip them
    try {
      const datesResp = await fetch(
        `${apiUrl}/api/insights/dates?machineId=${encodeURIComponent(daily.machineId)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (datesResp.ok) {
        const { dates } = (await datesResp.json()) as { dates: string[] };
        existingDates = new Set(dates);
      }
    } catch {
      // Failed to fetch dates — fall back to full sync (cloud will upsert)
    }

    const batches = buildInsightsSyncBatches(daily.days, existingDates, today);
    const totalDays = batches.reduce((sum, batch) => sum + batch.length, 0);
    if (totalDays === 0) return { synced: 0, total: 0 };

    let synced = 0;
    for (const batch of batches) {
      let resp: Response;
      try {
        resp = await fetch(`${apiUrl}/api/insights/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...daily, days: batch }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        return {
          synced,
          total: totalDays,
          error: e instanceof Error ? e.message : "Network error",
        };
      }

      if (resp.status === 401) {
        await clearLocalAuthSession();
        return { synced, total: totalDays, error: "Session expired" };
      }
      if (!resp.ok) {
        const err = await resp.text().catch(() => `HTTP ${resp.status}`);
        return { synced, total: totalDays, error: err };
      }

      let result: { synced: number };
      try {
        result = await resp.json();
      } catch {
        return { synced, total: totalDays, error: "Invalid response" };
      }

      synced += result.synced;
    }

    return { synced, total: totalDays };
  };

  /**
   * Auto-sync insights to cloud if user is logged in.
   * Normal scans run at most once per calendar day; usage backfills may force
   * a refresh of the current day's row after enriching the persisted snapshot.
   */
  const autoSyncInsights = (force = false): Promise<void> => {
    const today = localDayKey(new Date())!;
    if (!force && lastAutoSyncDate === today) return Promise.resolve();
    // Serialize through syncLock to prevent concurrent read-modify-write on the store
    const job = syncLock.then(async () => {
      if (!force && lastAutoSyncDate === today) return; // Re-check after acquiring lock
      const result = await syncInsightsToCloud();
      if (!result.error) lastAutoSyncDate = today;
    });
    syncLock = job.catch(() => {});
    return job;
  };

  /** Pre-compute all insights from scan results and store in cache. */
  let insightsPrecomputeChain: Promise<void> = Promise.resolve();
  const precomputeInsightsCache = (results: SessionScanResult[]): Promise<void> => {
    // Project memory reads make this operation asynchronous. Serialize cache
    // writes so the usage-enriched backfill cannot be overwritten by the fast
    // pass completing later.
    const job = insightsPrecomputeChain.then(async () => {
      // User-level insights
      const user = aggregateUserInsights(results);

      // Project-level insights for each unique project
      const projects = new Map<string, ProjectInsights>();
      const uniqueProjects = new Map<
        string,
        {
          project: string;
          identity?: ProjectInsights["projectIdentity"];
          location: ProjectInsightLocation;
        }
      >();
      for (const result of results) {
        const location: ProjectInsightLocation =
          result.location?.kind === "ssh" ? result.location : "local";
        const key = projectInsightKey(result.project, result.projectIdentity, location);
        if (!uniqueProjects.has(key)) {
          uniqueProjects.set(key, {
            project: result.project,
            identity: result.projectIdentity,
            location,
          });
        }
      }
      for (const [key, entry] of uniqueProjects) {
        const memoryProject =
          entry.location === "local" ? entry.identity?.key || entry.project : entry.project;
        const memory =
          entry.location === "local" && isFilesystemProjectKey(memoryProject)
            ? await readProjectMemory(memoryProject)
            : undefined;
        const pi = aggregateProjectInsights(
          entry.project,
          results,
          memory || undefined,
          entry.location,
        );
        projects.set(key, pi);
      }

      // Enrich topProjects with memoryFileCount
      for (const tp of user.topProjects) {
        const location: ProjectInsightLocation =
          tp.location?.kind === "ssh" ? tp.location : "local";
        const pi = projects.get(projectInsightKey(tp.project, tp.projectIdentity, location));
        if (pi?.memory) {
          tp.memoryFileCount = pi.memory.memoryFiles.length;
        }
      }

      insightsCache = {
        userInsights: user,
        projectInsights: projects,
        computedAt: new Date().toISOString(),
      };
      await writeFileCache<PersistedInsightsCache>(insightsCacheKey, {
        userInsights: insightsCache.userInsights,
        projectInsights: [...insightsCache.projectInsights.entries()],
        computedAt: insightsCache.computedAt,
      });
    });
    insightsPrecomputeChain = job.catch(() => {});
    return job;
  };

  /**
   * Second pass over sessions the fast scan indexed in a cheaper mode. Cursor's
   * SQLite-backed sessions skip rich parsing there (it costs ~250ms each), which
   * also means no tool/MCP/skill usage — the dominant gap for usage analytics.
   * Results are spliced in as they land and rewritten to the scan cache, so the
   * cost is paid once per session rather than on every dashboard launch.
   */
  const backfillDeferredUsage = async (
    scanInputs: ScanInput[],
    fastResults: SessionScanResult[],
    generation: number,
  ): Promise<void> => {
    const pending = scanInputs
      .filter((input) => input.deferRichCursorParse && (input.hasSqlite || input.hasSdk))
      .map((input) => ({ ...input, deferRichCursorParse: false }));
    if (pending.length === 0) {
      drainQueuedScan();
      return;
    }

    const superseded = (): boolean => generation !== scanGeneration;
    scanState = {
      ...scanState,
      usageBackfill: { running: true, scanned: 0, total: pending.length },
    };

    try {
      const enriched = await runBackgroundScan(
        pending,
        (progress) => {
          if (superseded()) return;
          scanState = {
            ...scanState,
            usageBackfill: { running: true, scanned: progress.scanned, total: progress.total },
          };
        },
        {
          // An empty usage summary is a valid result: it means the rich pass
          // ran and found no tools/skills. Only retry sessions whose result
          // still advertises that usage indexing was deferred.
          rescanCached: (cached) => cached.usageIndexed !== true,
          shouldStop: superseded,
        },
      );
      if (superseded()) return;

      const byKey = new Map(
        enriched.map((result) => [
          providerSessionKey(
            result.provider,
            result.sessionId,
            result.location?.kind === "ssh" ? result.location.id : undefined,
          ),
          result,
        ]),
      );
      const merged = fastResults.map(
        (result) =>
          byKey.get(
            providerSessionKey(
              result.provider,
              result.sessionId,
              result.location?.kind === "ssh" ? result.location.id : undefined,
            ),
          ) || result,
      );
      scanState = {
        ...scanState,
        results: merged,
        usageBackfill: { running: true, scanned: enriched.length, total: pending.length },
      };

      await writeFileCache(scanResultsCacheKey, merged);
      await persistInsightsFromScan(merged).catch(() => {});
      // The fast pass may already have consumed today's normal sync gate. The
      // backfill changes the persisted snapshot, so it must sync today's row
      // again; buildInsightsSyncBatches deliberately keeps today in the delta.
      void autoSyncInsights(true).catch(() => {});
      // Do not advertise the backfill as complete until the usage-enriched
      // project/user cache is also ready; otherwise the viewer can fetch the
      // old fast-pass insights in the small window between these operations.
      await precomputeInsightsCache(merged).catch(() => {});
      if (superseded()) return;
      scanState = {
        ...scanState,
        usageBackfill: { running: false, scanned: enriched.length, total: pending.length },
        revision: scanState.revision + 1,
        hasSnapshot: true,
      };
      drainQueuedScan();
    } catch {
      if (!superseded()) {
        scanState = {
          ...scanState,
          usageBackfill: {
            running: false,
            scanned: scanState.usageBackfill?.scanned ?? 0,
            total: scanState.usageBackfill?.total ?? 0,
          },
        };
        drainQueuedScan();
      }
    }
  };

  /**
   * Start background session scanning. Discovers all sessions, then scans
   * each one (newest first) to extract metadata for insights. Uses cache
   * so unchanged sessions are skipped.
   */
  const startBackgroundScan = (hints: EnrichmentHints = {}): void => {
    // The backfill writes the same scan cache as the fast pass. Starting a new
    // full scan while it is still writing could let the older snapshot win and
    // discard newly discovered entries, so let the current generation finish.
    if (scanState.running || scanState.usageBackfill?.running) return;
    const generation = ++scanGeneration;
    const previousResults = scanState.results;
    const previousRevision = scanState.revision;
    const previousHasSnapshot = scanState.hasSnapshot;
    const previousFinishedAt = scanState.finishedAt;
    scanState = {
      running: true,
      scanned: 0,
      total: 0,
      results: previousResults,
      revision: previousRevision,
      hasSnapshot: previousHasSnapshot,
      phase: "discovering",
      startedAt: new Date().toISOString(),
      finishedAt: previousFinishedAt,
      failedProviders: [],
    };

    void (async () => {
      try {
        // Discover all sessions
        const discovery = await discoverAllProviders(async () => {
          scanState = {
            ...scanState,
            phase: "discovering",
            scanned: scanState.scanned + 1,
            total: 0,
          };
        });
        const merged = mergeSameSessions(discovery.sessions);
        scanState.failedProviders = discovery.failedProviders;

        // Normalize project paths
        const home = homedir();
        for (const s of merged) {
          s.project = shortenPath(s.project, home);
        }
        lastDiscoveredMergedSessions = merged.map((session) => ({ ...session }));

        // Build scan inputs, then rank the catch-up order so new and UI-hinted
        // sessions land in the scan cache before long-tail unchanged history.
        const scanInputs: ScanInput[] = prioritizeScanInputs(
          merged.map((s) => ({
            sessionId: s.sessionId,
            provider: s.provider,
            location: s.location,
            transcriptStatus: s.transcriptStatus,
            project: s.project,
            projectIdentity:
              s.projectIdentity || classifyProject(s.project, { provider: s.provider }),
            slug: s.slug,
            filePaths: s.filePaths,
            toolPaths: s.toolPaths,
            sourceFilePath: s.filePath,
            sourceFileSize: s.fileSize,
            sourceLineCount: s.lineCount,
            workspacePath: s.workspacePath,
            hasSqlite: s.hasSqlite,
            hasSdk: s.hasSdk,
            sourceFingerprint: s.sourceFingerprint,
            deferRichCursorParse: s.provider === "cursor" && !!(s.hasSqlite || s.hasSdk),
            timestamp: s.timestamp,
            title: s.title,
            firstPrompt: s.firstPrompt,
            discoveryPromptCount: s.promptCount,
            discoveryToolCallCount: s.toolCallCount,
            discoveryEditCount: s.editCountEst,
            discoveryCompactionCount: s.compactionCount,
            discoveryModel: s.model,
            discoveryDurationMs: s.durationMsEst,
            remoteHome: getRemoteHome(s.location?.kind === "ssh" ? s.location.id : undefined),
          })),
          previousResults,
          hints,
        );

        scanState = {
          ...scanState,
          scanned: 0,
          total: scanInputs.length,
        };

        const freshResults = await runBackgroundScan(scanInputs, (progress) => {
          scanState = {
            ...scanState,
            phase: "scanning",
            scanned: progress.scanned,
            total: progress.total,
            currentSession: progress.currentSession,
          };
        });
        const results = preserveFailedProviderScanResults(
          freshResults,
          previousResults,
          discovery.failedProviders,
        );

        scanState = {
          running: false,
          scanned: results.length,
          total: scanInputs.length,
          results,
          revision: scanState.revision + 1,
          hasSnapshot: true,
          currentSession: undefined,
          phase: undefined,
          startedAt: scanState.startedAt,
          finishedAt: new Date().toISOString(),
          failedProviders: scanState.failedProviders || [],
        };

        await writeFileCache(scanResultsCacheKey, results);

        // Persist insights to durable local store (survives source file deletion)
        persistInsightsFromScan(results)
          .then(() => autoSyncInsights()) // Auto-sync to cloud if logged in
          .catch(() => {});

        // Pre-compute insights cache in background (non-blocking)
        precomputeInsightsCache(results).catch(() => {});

        void backfillDeferredUsage(scanInputs, results, generation);
      } catch {
        scanState = {
          ...scanState,
          running: false,
          currentSession: undefined,
          phase: undefined,
          finishedAt: new Date().toISOString(),
        };
        drainQueuedScan();
      }
    })();
  };

  const drainQueuedScan = (): void => {
    if (!queuedScanHints || scanState.running || scanState.usageBackfill?.running) return;
    const hints = queuedScanHints;
    queuedScanHints = undefined;
    startBackgroundScan(hints);
  };

  const requestBackgroundScan = (hints: EnrichmentHints = {}): boolean => {
    if (scanState.running || scanState.usageBackfill?.running) {
      queuedScanHints = mergeEnrichmentHints(queuedScanHints, hints);
      return true;
    }
    startBackgroundScan(hints);
    return false;
  };

  // A previous process can have persisted the fast Cursor snapshot and exited
  // before its in-memory usage backfill ran. Do not rely on the viewer mounting
  // and POSTing /api/scan/start to recover those facets; API consumers and a
  // browser opened directly on a cached page need the same startup guarantee.
  if (countPendingCursorUsageIndexes(scanState.results) > 0) {
    startBackgroundScan();
  }

  const app = new Hono();

  registerSameOriginMutationGuard(app);

  // Dashboard APIs are mutable scan snapshots. Prevent browser/proxy caching
  // from serving an earlier aggregate after a background scan completes.
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
  });

  registerAssistantRoutes(app, {
    baseDir,
    isSameOriginSettingsRequest,
    readSourcesCatalogCache,
    scanReplays: () => scanSessions(baseDir),
    loadSession: (slug, targetId) => loadSessionFromDisk(baseDir, slug, targetId),
    getScanState: () => scanState,
    getInsightsCache: () => insightsCache,
    getLatestSourceFailures: () => latestSourceFailures,
  });

  // Serve viewer HTML with editor flag (prod) or redirect to Vite dev server (dev)
  app.get("/", (c) => {
    if (isDevMode) {
      // In dev mode, redirect to Vite dev server which has HMR
      const viteUrl = new URL(opts!.externalViewerUrl!);
      // Preserve query params (e.g. ?session=xxx, ?view=dashboard)
      const incoming = new URL(c.req.url, "http://localhost");
      viteUrl.search = incoming.search;
      return c.redirect(viteUrl.toString(), 302);
    }
    const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
    // Reuse injectDataScript so we get the same `lastIndexOf("</head>")` handling
    // (minified JS in the viewer bundle may contain the literal string `</head>`)
    // plus a clear error if the build is corrupted, instead of silently producing
    // broken HTML.
    const html = injectDataScript(viewerHtml, flag);
    return c.html(html);
  });

  registerReplayRoutes(app, {
    baseDir,
    scanReplays: () => scanSessions(baseDir),
    refreshReplaysCache,
    syncSourcesCacheWithReplays,
    replaysCacheKey,
    loadSession: (slug, targetId) => loadSessionFromDisk(baseDir, slug, targetId),
  });

  registerLiveRoutes(app);

  registerArchiveRoutes(app, { baseDir });
  registerSourceRoutes(app, {
    baseDir,
    cleanupPeriodDays,
    readSourcesCatalogCache,
    writeDiscoveredSourcesCatalog,
    getStaleSourceProviders,
    discoverAllProviders,
    buildSourcesResult,
    normalizeSessionProjectsForHome,
    enrichCursorStatsInBackground,
    getSourcesEnrichmentStatus: () => sourcesEnrichmentStatus,
    getLastDiscoveredMergedSessions: () => lastDiscoveredMergedSessions,
    setLastDiscoveredMergedSessions: (sessions) => {
      lastDiscoveredMergedSessions = sessions;
    },
    getLatestSourceFailures: () => latestSourceFailures,
    setLatestSourceFailures: (failures) => {
      latestSourceFailures = failures;
    },
    getRemoteConfigChangedAt: () => remoteConfigChangedAt,
    setRemoteConfigChangedAt: (value) => {
      remoteConfigChangedAt = value;
    },
    requestBackgroundScan,
    isSameOriginSettingsRequest,
  });

  registerGenerationRoutes(app, {
    baseDir,
    discoverAllProviders: () => discoverAllProviders(),
    refreshReplaysCache,
    syncSourcesCacheWithReplays,
  });

  registerInsightsRoutes(app, {
    getScanState: () => scanState,
    getInsightsCache: () => insightsCache,
    requestBackgroundScan,
    refreshReplaysCache,
    readCachedReplays: async () =>
      (await readFileCache<ReplaySummary[]>(replaysCacheKey))?.data || [],
    syncInsightsToCloud,
  });

  registerSessionAssetRoutes(app, {
    baseDir,
    loadSession: (slug, targetId) => loadSessionFromDisk(baseDir, slug, targetId),
  });

  registerSessionOutputRoutes(app, {
    baseDir,
    loadSession: (slug, targetId) => loadSessionFromDisk(baseDir, slug, targetId),
  });

  // Auth — read local auth.json (per-environment, keyed by API origin)
  // The BFF proxy follows the TOKEN, not the env var: if no token for the
  // current VIBE_REPLAY_API_URL, it uses whatever token is available and
  // proxies to that token's origin (e.g. production) instead.
  const cloudApiBaseUrl = getApiUrl();

  const { readLocalAuthSession, isAuthValid, clearLocalAuthSession, fetchCloudApiWithLocalAuth } =
    createAuthSession(cloudApiBaseUrl);

  registerAuthRoutes(app, {
    cloudApiBaseUrl,
    readLocalAuthSession,
    isAuthValid,
    clearLocalAuthSession,
    autoSyncInsights,
  });

  // Proxy cloud APIs via local auth session (BFF mode for editor)
  // This keeps pnpm dev/start/npx behavior consistent and avoids cross-site cookie issues.
  registerCloudProxyRoutes(app, { fetchCloudApiWithLocalAuth });

  // System checks — AI Studio is powered by the embedded Pi runtime.
  app.get("/api/system-checks", async (c) => {
    const requested = c.req.query("tool");
    if (requested && requested !== "pi") {
      return c.json({ error: `Unknown tool: ${requested}` }, 400);
    }

    try {
      const runtime = getAiRuntime();
      const providers = await runtime.listProviders({ signal: c.req.raw.signal });
      const configured = providers.filter((provider) => provider.configured).length;
      const check = {
        name: "pi",
        label: "Pi AI",
        purpose: "Embedded provider and agent runtime for AI Studio",
        installed: true,
        version: "embedded",
        detail:
          configured > 0
            ? `${configured} provider${configured === 1 ? "" : "s"} configured`
            : "no provider configured",
      };
      return c.json({ checks: [check] });
    } catch (err) {
      return c.json({
        checks: [
          {
            name: "pi",
            label: "Pi AI",
            purpose: "Embedded provider and agent runtime for AI Studio",
            installed: false,
            detail: await getAiRuntime().getSafeErrorMessage(err),
          },
        ],
      });
    }
  });

  registerAiRoutes(app, {
    baseDir,
    loadSession: (slug, targetId) => loadSessionFromDisk(baseDir, slug, targetId),
    isSameOriginSettingsRequest,
  });

  // Dev mode: use VIBE_API_PORT env (set by scripts/dev.mjs) or fall back to 13456
  // Production: port 0 lets the OS pick a free port (no conflicts)
  const requestedPort = opts?.externalViewerUrl ? Number(process.env.VIBE_API_PORT) || 13456 : 0;

  const _server = serve(
    { fetch: app.fetch, port: requestedPort, hostname: "127.0.0.1" },
    (info) => {
      const port = info.port;
      const url = `http://localhost:${port}`;

      // Build the URL to open in the browser
      let browseUrl: string;
      const viewerBase = opts?.externalViewerUrl || url;
      if (opts?.openLive) {
        const qp = new URLSearchParams({
          live: "1",
          provider: opts.openLive.provider,
          sessionId: opts.openLive.sessionId,
        });
        browseUrl = `${viewerBase}/?${qp.toString()}`;
      } else if (opts?.openDashboard) {
        browseUrl = `${viewerBase}/?view=dashboard`;
      } else if (opts?.openSlug) {
        const qp = new URLSearchParams({ session: opts.openSlug });
        if (opts.openTargetId) qp.set("targetId", opts.openTargetId);
        browseUrl = `${viewerBase}/?${qp.toString()}`;
      } else {
        browseUrl = `${viewerBase}/?view=dashboard`;
      }

      const label = opts?.openLive
        ? "Live"
        : opts?.openDashboard || !opts?.openSlug
          ? "Dashboard"
          : "Editor";
      if (opts?.externalViewerUrl) {
        console.log(
          chalk.bold.cyan(`\n  ${label} API running on port ${port}`) +
            chalk.dim(" → ") +
            chalk.white(browseUrl) +
            chalk.dim("\n  Press Ctrl+C to stop\n"),
        );
      } else {
        console.log(
          chalk.bold.cyan(`\n  ${label} running at `) +
            chalk.white(browseUrl) +
            chalk.dim("\n  Press Ctrl+C to stop\n"),
        );
      }
      if (process.env.VIBE_REPLAY_NO_AUTO_OPEN !== "1") {
        open(browseUrl);
      }
    },
  );

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log(chalk.dim("\n  Server stopped.\n"));
      resolve();
      process.exit(0);
    });
  });
}

/**
 * Start dashboard mode — no existing replays required.
 */
export async function startDashboard(
  baseDir: string,
  opts?: { externalViewerUrl?: string },
): Promise<void> {
  await startServer(baseDir, { openDashboard: true, externalViewerUrl: opts?.externalViewerUrl });
}
