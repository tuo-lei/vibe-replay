import type { Hono } from "hono";
import { buildInsightsRollup } from "../insights-rollup.js";
import { readInsightsStore } from "../insights.js";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  type BackgroundScanState,
  countPendingCursorUsageIndexes,
  type ProjectInsights,
  projectInsightKey,
  readProjectMemory,
  type ProjectInsightLocation,
} from "../scanner.js";
import { buildUsageCoverageReport } from "../usage-coverage.js";
import { enrichmentHintsFromBody } from "../server-enrichment.js";
import { safeTargetId } from "../server-core.js";
import type { ReplaySummary } from "../server-types.js";
import { recordTelemetry } from "../telemetry.js";

interface InsightsCache {
  userInsights: ReturnType<typeof aggregateUserInsights> | null;
  projectInsights: Map<string, ProjectInsights>;
}

interface SyncResult {
  synced: number;
  total: number;
  error?: string;
}

interface InsightsRouteDeps {
  getScanState: () => BackgroundScanState;
  getInsightsCache: () => InsightsCache;
  requestBackgroundScan: (hints: ReturnType<typeof enrichmentHintsFromBody>) => boolean;
  refreshReplaysCache: () => Promise<ReplaySummary[] | null>;
  readCachedReplays: () => Promise<ReplaySummary[]>;
  syncInsightsToCloud: () => Promise<SyncResult>;
}

/** Scanner, usage, and durable insights endpoints. */
export function registerInsightsRoutes(app: Hono, deps: InsightsRouteDeps): void {
  const {
    getScanState,
    getInsightsCache,
    requestBackgroundScan,
    refreshReplaysCache,
    readCachedReplays,
    syncInsightsToCloud,
  } = deps;

  app.post("/api/scan/start", async (c) => {
    const hints = enrichmentHintsFromBody(await c.req.json().catch(() => undefined));
    const queued = requestBackgroundScan(hints);
    return c.json({
      ok: true,
      queued,
      message: queued ? "Background scan queued" : "Background scan started",
    });
  });

  app.get("/api/scan/status", async (c) => {
    const scanState = getScanState();
    const insightsCache = getInsightsCache();
    return c.json({
      running: scanState.running,
      scanned: scanState.scanned,
      total: scanState.total,
      resultCount: scanState.results.length,
      revision: scanState.revision,
      hasSnapshot: scanState.hasSnapshot,
      currentSession: scanState.currentSession,
      phase: scanState.phase,
      startedAt: scanState.startedAt,
      finishedAt: scanState.finishedAt,
      failedProviders: scanState.failedProviders || [],
      usageBackfill: scanState.usageBackfill,
      usageIndexPending: countPendingCursorUsageIndexes(scanState.results),
      hasInsights: insightsCache.userInsights !== null,
      hasCachedResults: scanState.results.length > 0,
      cachedResultCount: scanState.results.length,
      cachedAt: scanState.finishedAt,
    });
  });

  app.get("/api/scan/results", async (c) => {
    const scanState = getScanState();
    return c.json({
      // Invocation events are available from the focused usage endpoint; keep
      // the dashboard's initial scan payload bounded to per-session summaries.
      results: scanState.results.map((result) => ({ ...result, usageEvents: undefined })),
      running: scanState.running,
      scanned: scanState.scanned,
      total: scanState.total,
      revision: scanState.revision,
      finishedAt: scanState.finishedAt,
      failedProviders: scanState.failedProviders || [],
    });
  });

  app.get("/api/usage/events", async (c) => {
    const provider = c.req.query("provider");
    const sessionId = c.req.query("sessionId");
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    if (!provider || !sessionId) {
      return c.json({ error: "provider and sessionId are required" }, 400);
    }
    const scanState = getScanState();
    const result = scanState.results.find(
      (scan) =>
        scan.provider === provider &&
        scan.sessionId === sessionId &&
        (targetId
          ? scan.location?.kind === "ssh" && scan.location.id === targetId
          : scan.location?.kind !== "ssh"),
    );
    if (!result) return c.json({ error: "Session usage not found" }, 404);
    return c.json({
      provider,
      sessionId,
      ...(result.location ? { location: result.location } : {}),
      summary: result.usageSummary,
      events: result.usageEvents || [],
    });
  });

  // Compact projection of the scan results: just enough to aggregate usage over
  // any time range client-side, without shipping the multi-MB scan payload.
  app.get("/api/usage/rollup", async (c) => {
    const scanState = getScanState();
    const sessions = scanState.results
      .filter((scan) => scan.usageSummary)
      .map((scan) => ({
        provider: scan.provider,
        sessionId: scan.sessionId,
        ...(scan.location ? { location: scan.location } : {}),
        project: scan.project,
        startTime: scan.startTime,
        usage: scan.usageSummary,
      }));
    return c.json({
      sessions,
      indexedSessions: scanState.results.filter((scan) => scan.usageIndexed === true).length,
      totalSessions: scanState.results.length,
      scannedAt: scanState.finishedAt,
      coverage: buildUsageCoverageReport(scanState.results),
    });
  });

  // Compact per-session projection for exact 7d/30d/90d insight totals and
  // range-scoped secondary breakdowns. Conversation content and tool
  // inputs/results intentionally never leave the scanner here.
  app.get("/api/insights/rollup", async (c) => {
    const scanState = getScanState();
    if (!scanState.hasSnapshot) {
      return c.json({ error: "No scan results available. Start a scan first." }, 503);
    }
    // Replay files can be created or deleted without a source scan, so refresh
    // this small list instead of trusting a potentially stale dashboard cache.
    const refreshedReplays = await refreshReplaysCache();
    const replays = refreshedReplays || (await readCachedReplays());
    return c.json(buildInsightsRollup(scanState.results, replays, { includeDetails: true }));
  });

  app.get("/api/insights", async (c) => {
    const project = c.req.query("project");
    const scanState = getScanState();
    const insightsCache = getInsightsCache();

    if (project) {
      const targetId = safeTargetId(c.req.query("targetId"));
      if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
      const location: ProjectInsightLocation = targetId
        ? (scanState.results.find(
            (scan) => scan.location?.kind === "ssh" && scan.location.id === targetId,
          )?.location ?? { kind: "ssh", id: targetId, label: targetId })
        : "local";
      const cacheKey = projectInsightKey(project, undefined, location);
      // Project-level: cache hit → O(1), miss → compute on demand
      const cached =
        insightsCache.projectInsights.get(cacheKey) ||
        (location === "local" ? insightsCache.projectInsights.get(project) : undefined);
      if (cached) return c.json({ type: "project", insights: cached });

      const scans = scanState.results;
      if (!scans.length) {
        return c.json({ error: "No scan results available. Start a scan first." }, 404);
      }
      const memory = location === "local" ? await readProjectMemory(project) : undefined;
      const insights = aggregateProjectInsights(project, scans, memory || undefined, location);
      insightsCache.projectInsights.set(cacheKey, insights);
      return c.json({ type: "project", insights });
    }

    if (insightsCache.userInsights) {
      return c.json({ type: "user", insights: insightsCache.userInsights });
    }

    const scans = scanState.results;
    if (!scans.length) {
      return c.json({ error: "No scan results available. Start a scan first." }, 404);
    }
    const insights = aggregateUserInsights(scans);
    return c.json({ type: "user", insights });
  });

  // --- Local insights store (durable, survives source deletion) ---

  app.get("/api/insights/local", async (c) => {
    const store = await readInsightsStore();
    return c.json(store);
  });

  app.get("/api/insights/local/stats", async (c) => {
    const { getInsightsStats } = await import("../insights.js");
    const store = await readInsightsStore();
    return c.json(getInsightsStats(store));
  });

  app.post("/api/insights/sync", async (c) => {
    const result = await syncInsightsToCloud();
    if (result.error === "Not logged in") {
      return c.json({ error: "Not logged in. Run: vibe-replay auth login" }, 401);
    }
    if (result.error) {
      return c.json({
        error: `Sync failed: ${result.error}`,
        synced: result.synced,
        total: result.total,
      });
    }
    if (result.total === 0) {
      recordTelemetry("insights.sync");
      return c.json({ synced: 0, message: "All insights already synced" });
    }
    recordTelemetry("insights.sync");
    return c.json({
      synced: result.synced,
      total: result.total,
      message: `Synced ${result.synced} insights to cloud`,
    });
  });

  app.get("/api/memory", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project parameter required" }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    if (targetId !== undefined) {
      // Project memory is read from the local filesystem. Never let a remote
      // project request accidentally read a same-named local project's memory.
      return c.json({ memoryFiles: [], claudeMd: null });
    }

    const memory = await readProjectMemory(project);
    if (!memory) return c.json({ memoryFiles: [], claudeMd: null });
    return c.json(memory);
  });
}
