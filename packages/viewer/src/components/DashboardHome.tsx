import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatedValue } from "../hooks/useAnimatedNumber";
import type { SessionSummary, SourceSession } from "../types";
import { localDayKey } from "../utils/date";
import { SessionDetailPopup } from "./Dashboard";
import { ProviderBadge } from "./dashboard/DashboardShared";
import {
  fetchWithRetry,
  formatCompactDuration,
  isCacheFresh,
  navigateTo,
  normalizeTitleText,
  parseCachedList,
  projectName,
  replaySuggestedTitle,
  rollupTopProjects,
  shouldRefreshCachedList,
  type SourcesEnrichmentStatus,
  type TopProjectEntry,
  sourceSuggestedTitle,
  timeAgo,
} from "./dashboard-utils";
import { ContributionHeatmap } from "./InsightsPage";
import { useScanInsightsContext } from "./InsightsPanel";
import { DataLevelBadge, SessionLoadingToast, sessionDataState } from "./SessionDataProgress";
import { formatDuration } from "./StatsPanel";

// ─── Types ───────────────────────────────────────────────────────────

interface DashboardHomeProps {
  onNavigate: (view: "home" | "sessions" | "replays" | "projects" | "insights") => void;
}

interface InsightStats {
  totalSessions: number;
  totalReplays: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalDuration: number;
  projectCount: number;
  sessionsPerDay: Record<string, number>;
  recentSources: SourceSession[];
  recentReplays: SessionSummary[];
  publishedCount: number;
  replayConversionPct: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

// ─── Data Fetching ───────────────────────────────────────────────────

function useDashboardData() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [replays, setReplays] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingReplays, setLoadingReplays] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setScanProgress] = useState<number | null>(null);
  const [enrichmentStatus, setEnrichmentStatus] = useState<SourcesEnrichmentStatus | null>(null);
  const wasEnrichingRef = useRef(false);
  const lastSourcesCachedAtRef = useRef<string | undefined>(undefined);
  const hasCursorSources = useMemo(
    () => sources.some((source) => source.provider === "cursor"),
    [sources],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadingSources(true);
    setLoadingReplays(true);
    setError(null);

    try {
      const [sourcesRes, replaysRes] = await Promise.all([
        fetch("/api/sources/cached")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/sessions/cached")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      const cachedSources = parseCachedList<SourceSession>(sourcesRes);
      const cachedReplays = parseCachedList<SessionSummary>(replaysRes);

      if (cachedSources?.sessions.length) setSources(cachedSources.sessions);
      if (cachedReplays?.sessions.length) setReplays(cachedReplays.sessions);

      if (cachedSources?.sessions.length || cachedReplays?.sessions.length) {
        setLoading(false);
      }

      const sourceFresh = !shouldRefreshCachedList(cachedSources);
      const replayFresh = isCacheFresh(cachedReplays?.cachedAt);
      const refreshPromises: Promise<void>[] = [];

      if (sourceFresh) setLoadingSources(false);
      if (replayFresh) setLoadingReplays(false);

      if (!sourceFresh) {
        // Use SSE stream for discovery with progress reporting
        refreshPromises.push(
          new Promise<void>((resolve) => {
            setScanProgress(0);
            const es = new EventSource("/api/sources/stream");
            es.onmessage = (evt) => {
              try {
                const msg = JSON.parse(evt.data);
                if (msg.type === "progress") {
                  setScanProgress(msg.scanned);
                } else if (msg.type === "complete") {
                  setSources(msg.sessions);
                  setScanProgress(null);
                  es.close();
                  resolve();
                } else if (msg.type === "error") {
                  if (!cachedSources?.sessions.length) {
                    setError(msg.message || "Failed to load sessions");
                  }
                  setScanProgress(null);
                  es.close();
                  resolve();
                }
              } catch {
                // ignore parse errors
              }
            };
            es.onerror = () => {
              // SSE failed — fall back to regular fetch
              es.close();
              setScanProgress(null);
              fetchWithRetry("/api/sources")
                .then((r) => {
                  if (!r.ok) throw new Error("Failed to load sources");
                  return r.json();
                })
                .then((data: { sessions: SourceSession[] }) => setSources(data.sessions))
                .catch((err) => {
                  if (!cachedSources?.sessions.length) {
                    setError(err instanceof Error ? err.message : "Failed to load sessions");
                  }
                })
                .finally(() => resolve());
            };
          }).finally(() => setLoadingSources(false)),
        );
      }

      if (!replayFresh) {
        refreshPromises.push(
          fetchWithRetry("/api/sessions")
            .then((r) => {
              if (!r.ok) throw new Error("Failed to load replays");
              return r.json();
            })
            .then((data: SessionSummary[]) => setReplays(data))
            .catch((err) => {
              if (!cachedReplays?.sessions.length) {
                setError(err instanceof Error ? err.message : "Failed to load replays");
              }
            })
            .finally(() => setLoadingReplays(false)),
        );
      }

      if (refreshPromises.length > 0) await Promise.allSettled(refreshPromises);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!loadingSources && !hasCursorSources && !wasEnrichingRef.current) return;

    let cancelled = false;
    let timer: number | undefined;

    const maybeRefreshSourcesFromCache = async () => {
      const payload = await fetch("/api/sources/cached")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const cached = parseCachedList<SourceSession>(payload);
      if (
        !cancelled &&
        cached?.sessions.length &&
        cached.cachedAt !== lastSourcesCachedAtRef.current
      ) {
        lastSourcesCachedAtRef.current = cached.cachedAt;
        setSources(cached.sessions);
      }
    };

    const poll = async () => {
      const status = await fetch("/api/sources/enrichment-status")
        .then((r) => (r.ok ? (r.json() as Promise<SourcesEnrichmentStatus>) : null))
        .catch(() => null);
      if (!status || cancelled) return;
      setEnrichmentStatus(status);

      if (status.running) {
        wasEnrichingRef.current = true;
        await maybeRefreshSourcesFromCache();
      } else if (wasEnrichingRef.current) {
        wasEnrichingRef.current = false;
        await maybeRefreshSourcesFromCache();
        if (timer) {
          window.clearInterval(timer);
          timer = undefined;
        }
      }
    };

    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, 2500);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [hasCursorSources, loadingSources]);

  return {
    sources,
    setSources,
    replays,
    loading,
    loadingSources,
    loadingReplays,
    enrichmentStatus,
    error,
  };
}

// ─── Compute Insights ────────────────────────────────────────────────

function computeInsights(sources: SourceSession[], replays: SessionSummary[]): InsightStats {
  let totalPrompts = 0;
  let totalToolCalls = 0;
  let totalDuration = 0;

  // Source-level counts from lightweight scan, fallback to replay stats
  const srcBySlug = new Map(sources.map((s) => [s.slug, s]));
  for (const s of sources) {
    totalPrompts += s.promptCount ?? (s.prompts?.length || (s.firstPrompt ? 1 : 0));
    totalToolCalls += s.toolCallCount ?? 0;
  }
  for (const r of replays) {
    const src = srcBySlug.get(r.slug);
    const replayToolCalls = r.stats.toolCalls || 0;
    if (!src) {
      totalPrompts += r.stats.userPrompts || 0;
      totalToolCalls += replayToolCalls;
    } else if (src.toolCallCount == null) {
      totalToolCalls += replayToolCalls;
    } else if (replayToolCalls > src.toolCallCount) {
      // Invariant: source and replay represent the same session; replay stats can be more complete.
      // We only add the delta here to avoid double-counting counts already included from sources.
      totalToolCalls += replayToolCalls - src.toolCallCount;
    }
    totalDuration += r.stats.durationMs || 0;
  }

  // Projects
  const projects = new Set<string>();
  for (const s of sources) projects.add(s.project);
  for (const r of replays) projects.add(r.project);

  // Home activity should reflect the latest discovered sessions immediately,
  // even while richer scan insights are still refreshing in the background.
  const sessionsPerDay: Record<string, number> = {};
  for (const s of sources) {
    const day = localDayKey(s.timestamp);
    if (!day) continue;
    sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;
  }

  const totalSessions = sources.length;
  const totalReplays = replays.length;
  const sessionsWithReplay = sources.filter((s) => s.existingReplay).length;
  const replayConversionPct = totalSessions > 0 ? (sessionsWithReplay / totalSessions) * 100 : 0;

  return {
    totalSessions,
    totalReplays,
    totalPrompts,
    totalToolCalls,
    totalDuration,
    projectCount: projects.size,
    sessionsPerDay,
    recentSources: [...sources].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5),
    recentReplays: [...replays].sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 5),
    publishedCount: replays.filter((r) => r.gist?.gistId).length,
    replayConversionPct,
  };
}

type LocalProjectAccumulator = TopProjectEntry & {
  branches: Set<string>;
};

function createLocalProject(project: string): LocalProjectAccumulator {
  return {
    project,
    sessions: 0,
    cost: 0,
    prompts: 0,
    durationMs: 0,
    toolCalls: 0,
    edits: 0,
    branchCount: 0,
    prCount: 0,
    memoryFileCount: 0,
    lastActivity: "",
    sessionsPerDay: {},
    branches: new Set(),
  };
}

function computeLocalTopProjects(
  sources: SourceSession[],
  replays: SessionSummary[],
): TopProjectEntry[] {
  const byProject = new Map<string, LocalProjectAccumulator>();
  const replayBySlug = new Map(replays.map((replay) => [replay.slug, replay]));
  const countedReplaySlugs = new Set<string>();

  const entryFor = (project: string) => {
    const existing = byProject.get(project);
    if (existing) return existing;
    const created = createLocalProject(project);
    byProject.set(project, created);
    return created;
  };

  const bumpActivity = (entry: LocalProjectAccumulator, timestamp: string) => {
    if (timestamp > entry.lastActivity) entry.lastActivity = timestamp;
    const day = localDayKey(timestamp);
    if (day) entry.sessionsPerDay[day] = (entry.sessionsPerDay[day] || 0) + 1;
  };

  for (const source of sources) {
    const replay = replayBySlug.get(source.slug);
    if (replay) countedReplaySlugs.add(replay.slug);

    const entry = entryFor(source.project);
    entry.sessions += 1;
    entry.cost += replay?.stats.costEstimate ?? 0;
    entry.prompts +=
      source.promptCount ?? source.prompts?.length ?? (source.firstPrompt.trim() ? 1 : 0);
    entry.toolCalls += Math.max(source.toolCallCount ?? 0, replay?.stats.toolCalls ?? 0);
    entry.durationMs += source.durationMsEst ?? replay?.stats.durationMs ?? 0;
    entry.edits += source.editCountEst ?? 0;
    if (source.gitBranch) entry.branches.add(source.gitBranch);
    if (source.hasPR) entry.prCount += 1;
    bumpActivity(entry, source.timestamp);
  }

  for (const replay of replays) {
    if (countedReplaySlugs.has(replay.slug)) continue;

    const entry = entryFor(replay.project);
    entry.sessions += 1;
    entry.cost += replay.stats.costEstimate ?? 0;
    entry.prompts += replay.stats.userPrompts ?? 0;
    entry.toolCalls += replay.stats.toolCalls ?? 0;
    entry.durationMs += replay.stats.durationMs ?? 0;
    bumpActivity(entry, replay.startTime);
  }

  const projects = [...byProject.values()].map(({ branches, ...entry }) => ({
    ...entry,
    branchCount: branches.size,
  }));

  return rollupTopProjects(projects);
}

// ─── UI Components ───────────────────────────────────────────────────

const HOME_RECENT_PROJECT_LIMIT = 6;
const ACTIVE_SESSION_GRACE_MS = 5 * 60 * 1000;
type ActivityWindow = "today" | "week";

function InfoTooltip({ children }: { children: React.ReactNode }) {
  return (
    <span className="instant-tooltip inline-flex h-4 w-4 items-center justify-center rounded-full border border-terminal-border-subtle text-[10px] font-mono text-terminal-dimmer">
      ?<span className="instant-tooltip-text w-64 text-left">{children}</span>
    </span>
  );
}

function isLikelyActiveSource(s: SourceSession): boolean {
  const timestamp = Date.parse(s.timestamp);
  return Number.isFinite(timestamp) && Date.now() - timestamp < ACTIVE_SESSION_GRACE_MS;
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function RecentProjectsSkeleton() {
  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-28 skeleton rounded" />
        <div className="h-3 w-14 skeleton rounded" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.from({ length: HOME_RECENT_PROJECT_LIMIT }, (_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-2 px-3 py-3 rounded-lg bg-terminal-bg"
          >
            <div className="min-w-0 flex-1 space-y-2.5">
              <div
                className="h-3.5 skeleton rounded"
                style={{ width: `${50 + ((i * 17) % 30)}%` }}
              />
              <div className="h-3 skeleton rounded" style={{ width: `${60 + ((i * 23) % 25)}%` }} />
            </div>
            <div className="h-4 w-14 shrink-0 skeleton rounded" />
          </div>
        ))}
      </div>
      <div className="h-8 mt-2 rounded-lg skeleton" />
    </div>
  );
}

function RecentSessionsList({
  sessions,
  isLoading,
  enrichmentStatus,
  onGenerate,
  onViewReplay,
  onSessionClick,
  generatingSlug,
  generateErrorSlug,
}: {
  sessions: SourceSession[];
  isLoading: boolean;
  enrichmentStatus?: SourcesEnrichmentStatus | null;
  onGenerate: (source: SourceSession) => void;
  onViewReplay: (slug: string) => void;
  onSessionClick: (source: SourceSession) => void;
  generatingSlug: string | null;
  generateErrorSlug: string | null;
}) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-6 text-terminal-dimmer text-xs font-mono">
        {isLoading
          ? "Loading recent sessions..."
          : "No sessions found. Start Claude, Cursor, or Codex."}
      </div>
    );
  }

  const renderAction = (s: SourceSession, featured = false) => {
    const hasReplay = !!s.existingReplay;
    const isGenerating = generatingSlug === s.slug;
    const hasError = generateErrorSlug === s.slug;
    const sizeClass = featured ? "h-8 px-3.5" : "h-7 px-3";

    if (hasReplay) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onViewReplay(s.existingReplay!);
          }}
          className={`${sizeClass} text-xs font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 flex items-center gap-1 shrink-0`}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <polygon points="4 2 14 8 4 14" />
          </svg>
          {featured ? "Open replay" : "Open"}
        </button>
      );
    }

    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onGenerate(s);
        }}
        disabled={isGenerating}
        className={`${sizeClass} text-xs font-sans font-semibold rounded-md transition-all duration-200 disabled:opacity-50 flex items-center gap-1 shrink-0 ${
          hasError
            ? "bg-terminal-red-subtle text-terminal-red"
            : "bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis"
        }`}
      >
        {isGenerating ? (
          <span className="animate-pulse">{featured ? "Generating..." : "..."}</span>
        ) : hasError ? (
          "Failed"
        ) : (
          <>
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M8 2v12M2 8h12" />
            </svg>
            Generate
          </>
        )}
      </button>
    );
  };

  const sessionKey = (s: SourceSession) => `${s.provider}-${s.project}-${s.slug}`;
  const primary =
    sessions.find((s) => !s.existingReplay && !isLikelyActiveSource(s)) ??
    sessions.find((s) => !s.existingReplay) ??
    sessions[0];
  const primaryKey = sessionKey(primary);
  const rest = sessions.filter((s) => sessionKey(s) !== primaryKey);
  const primaryDataState = sessionDataState(primary, null);
  const primaryIsEnriching = Boolean(enrichmentStatus?.running) && primary.provider === "cursor";
  const primaryPromptCount = primary.promptCount ?? primary.prompts?.length ?? 0;
  const primaryToolCount = primary.toolCallCount ?? primary.replay?.stats.toolCalls ?? 0;
  const primaryHasReplay = !!primary.existingReplay;
  const primaryIsActive = isLikelyActiveSource(primary);
  const primaryToneClass = primaryHasReplay
    ? "border-terminal-green/25 hover:border-terminal-green/45"
    : "border-terminal-blue/25 hover:border-terminal-blue/45";

  return (
    <div className="space-y-3 flex-1 flex flex-col">
      <div
        onClick={() => onSessionClick(primary)}
        className={`rounded-xl border bg-terminal-bg/55 px-3 py-3 cursor-pointer transition-all duration-200 hover:bg-terminal-bg/80 ${primaryToneClass}`}
      >
        <div className="flex items-start gap-3">
          <ProviderBadge provider={primary.provider} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${
                  primaryHasReplay
                    ? "bg-terminal-green-subtle text-terminal-green"
                    : "bg-terminal-blue-subtle text-terminal-blue"
                }`}
              >
                {primaryHasReplay
                  ? "Recent replay"
                  : primaryIsActive
                    ? "Current activity"
                    : "Suggested next"}
              </span>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {timeAgo(primary.timestamp)}
              </span>
              {primaryIsEnriching && <DataLevelBadge state={primaryDataState} active compact />}
            </div>
            <p className="mt-1 text-sm font-sans font-semibold text-terminal-text truncate">
              {sourceSuggestedTitle(primary)}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-terminal-dimmer">
              <span className="truncate">{primary.gitRepo || projectName(primary.project)}</span>
              {primaryPromptCount > 0 && <span>{primaryPromptCount} prompts</span>}
              {primaryToolCount > 0 && <span>{primaryToolCount} tools</span>}
              <span className={primaryHasReplay ? "text-terminal-green" : "text-terminal-blue"}>
                {primaryHasReplay ? "generated" : "not generated"}
              </span>
            </div>
          </div>
          {renderAction(primary, true)}
        </div>
      </div>

      <div className="space-y-1">
        {rest.map((s) => {
          const isEnriching = Boolean(enrichmentStatus?.running) && s.provider === "cursor";
          const dataState = sessionDataState(s, null);
          return (
            <div
              key={sessionKey(s)}
              onClick={() => onSessionClick(s)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-terminal-surface-hover transition-colors duration-200 cursor-pointer"
            >
              <ProviderBadge provider={s.provider} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-sans text-terminal-text truncate">
                  {sourceSuggestedTitle(s)}
                </p>
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-[11px] font-mono text-terminal-dimmer truncate">
                    {s.gitRepo || projectName(s.project)}
                  </p>
                  {isEnriching && <DataLevelBadge state={dataState} active compact />}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] font-mono text-terminal-dimmer tabular-nums">
                  {timeAgo(s.timestamp)}
                </span>
                {renderAction(s)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentReplaysList({
  replays,
  isLoading,
  onOpen,
}: {
  replays: SessionSummary[];
  isLoading: boolean;
  onOpen: (slug: string) => void;
}) {
  if (replays.length === 0) {
    return (
      <div className="text-center py-6 text-terminal-dimmer text-xs font-mono">
        {isLoading ? "Loading replays..." : "No replays yet. Generate one from the Sessions tab."}
      </div>
    );
  }

  return (
    <div className="space-y-1 flex-1 flex flex-col">
      {replays.map((r) => (
        <button
          key={r.slug}
          onClick={() => onOpen(r.slug)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-terminal-surface-hover transition-colors duration-200 text-left group"
        >
          <ProviderBadge provider={r.provider} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-sans text-terminal-text truncate group-hover:text-terminal-green transition-colors">
              {replaySuggestedTitle(r)}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] font-mono text-terminal-dimmer">
                {r.stats.userPrompts} prompts
              </span>
              <span className="text-terminal-border text-[10px]">&middot;</span>
              <span className="text-[11px] font-mono text-terminal-dimmer">
                {r.stats.toolCalls} tools
              </span>
              {r.stats.durationMs && (
                <>
                  <span className="text-terminal-border text-[10px]">&middot;</span>
                  <span className="text-[11px] font-mono text-terminal-dimmer">
                    {formatDuration(r.stats.durationMs)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {r.gist?.gistId && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple">
                published
              </span>
            )}
            <span className="text-[11px] font-mono text-terminal-dimmer tabular-nums">
              {timeAgo(r.startTime)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── System Checks ──────────────────────────────────────────────────

interface TC {
  name: string;
  label: string;
  purpose: string;
  installed: boolean;
  version?: string;
  detail?: string;
  loading?: boolean;
}

const SYSTEM_TOOLS: Array<Pick<TC, "name" | "label" | "purpose">> = [
  { name: "claude", label: "Claude Code", purpose: "AI feedback via headless mode" },
  { name: "cursor", label: "Cursor CLI", purpose: "AI feedback via AI Studio" },
  { name: "opencode", label: "OpenCode", purpose: "AI feedback via headless mode" },
];

function SystemChecksSection() {
  const [checks, setChecks] = useState<TC[]>(() =>
    SYSTEM_TOOLS.map((tool) => ({
      ...tool,
      installed: false,
      detail: "checking...",
      loading: true,
    })),
  );

  useEffect(() => {
    let cancelled = false;
    for (const tool of SYSTEM_TOOLS) {
      fetch(`/api/system-checks?tool=${encodeURIComponent(tool.name)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { checks?: TC[] } | null) => {
          if (cancelled) return;
          const resolved = d?.checks?.find((entry) => entry.name === tool.name) || d?.checks?.[0];
          if (!resolved) {
            setChecks((prev) =>
              prev.map((entry) =>
                entry.name === tool.name
                  ? { ...entry, installed: false, detail: "check failed", loading: false }
                  : entry,
              ),
            );
            return;
          }
          setChecks((prev) =>
            prev.map((entry) =>
              entry.name === tool.name
                ? {
                    ...entry,
                    installed: Boolean(resolved.installed),
                    version: resolved.version,
                    detail: resolved.detail,
                    loading: false,
                  }
                : entry,
            ),
          );
        })
        .catch(() => {
          if (cancelled) return;
          setChecks((prev) =>
            prev.map((entry) =>
              entry.name === tool.name
                ? { ...entry, installed: false, detail: "check failed", loading: false }
                : entry,
            ),
          );
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const loadingChecks = checks.some((tool) => tool.loading);
  const missingChecks = checks.filter((tool) => !tool.loading && !tool.installed);

  if (loadingChecks) {
    return (
      <div className="bg-terminal-surface rounded-xl px-4 py-3 shadow-layer-sm">
        <div className="flex items-center gap-2 text-xs font-mono text-terminal-dim">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
          Checking local replay tools...
        </div>
      </div>
    );
  }

  if (missingChecks.length === 0) {
    return (
      <div className="bg-terminal-surface rounded-xl px-4 py-3 shadow-layer-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
              System Ready
            </h3>
            <p className="mt-0.5 text-[10px] font-mono text-terminal-dimmer">
              Local replay tooling is available.
            </p>
          </div>
          <span className="text-[10px] font-mono text-terminal-green">all checks passed</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
      <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-3">
        System Attention Needed
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {missingChecks.map((t) => (
          <div
            key={t.name}
            className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-terminal-bg"
          >
            <div
              className={`w-2 h-2 mt-1 rounded-full shrink-0 ${
                t.loading
                  ? "bg-terminal-blue animate-pulse"
                  : t.installed
                    ? "bg-terminal-green"
                    : "bg-terminal-dim opacity-40"
              }`}
            />
            <div className="min-w-0">
              <span
                className={`text-xs font-sans font-medium ${
                  t.loading
                    ? "text-terminal-dim"
                    : t.installed
                      ? "text-terminal-text"
                      : "text-terminal-dimmer"
                }`}
              >
                {t.label}
              </span>
              <p className="text-[10px] font-mono text-terminal-dimmer truncate">{t.purpose}</p>
              {t.loading ? (
                <p className="text-[10px] font-mono text-terminal-blue truncate animate-pulse">
                  checking...
                </p>
              ) : t.installed ? (
                <p className="text-[10px] font-mono text-terminal-green truncate">
                  {t.detail || t.version || "ready"}
                </p>
              ) : (
                <p className="text-[10px] font-mono text-terminal-orange truncate">
                  {t.detail || "not found"}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────

export default function DashboardHome({ onNavigate }: DashboardHomeProps) {
  const {
    sources,
    setSources,
    replays,
    loading,
    loadingSources,
    loadingReplays,
    enrichmentStatus,
    error,
  } = useDashboardData();
  const insights = useMemo(() => computeInsights(sources, replays), [sources, replays]);
  const { userInsights } = useScanInsightsContext();
  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateErrorSlug, setGenerateErrorSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<
    "idle" | "syncing" | "done" | "error" | "needsLogin" | "awaitingLogin"
  >("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>("today");
  const requestedEnrichmentSignatureRef = useRef("");
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedSession = selectedSlug
    ? (sources.find((s) => s.slug === selectedSlug) ?? null)
    : null;
  const localTopProjects = useMemo(
    () => computeLocalTopProjects(sources, replays),
    [sources, replays],
  );
  const rolledUpTopProjects = useMemo(
    () => (userInsights ? rollupTopProjects(userInsights.topProjects) : []),
    [userInsights],
  );
  const recentProjects = rolledUpTopProjects.length > 0 ? rolledUpTopProjects : localTopProjects;
  const showRecentProjectsSkeleton = loadingSources && recentProjects.length === 0;
  const displayProjectCount = Math.max(insights.projectCount, userInsights?.totalProjects ?? 0);
  const displayTotalPrompts = Math.max(insights.totalPrompts, userInsights?.totalPrompts ?? 0);
  const displayTotalToolCalls = Math.max(
    insights.totalToolCalls,
    userInsights?.totalToolCalls ?? 0,
  );
  const displaySessionsPerDay =
    Object.keys(insights.sessionsPerDay).length > 0
      ? insights.sessionsPerDay
      : (userInsights?.sessionsPerDay ?? {});
  const now = new Date();
  const activityStart = activityWindow === "today" ? startOfLocalDay(now) : startOfLocalWeek(now);
  const activityStartMs = activityStart.getTime();
  const activeSources = sources.filter((source) => {
    const timestamp = new Date(source.timestamp).getTime();
    return Number.isFinite(timestamp) && timestamp >= activityStartMs && timestamp <= now.getTime();
  });
  const activeSessions = activeSources.length;
  const activeProjectCount = new Set(activeSources.map((source) => source.project)).size;
  const activePrompts = activeSources.reduce(
    (total, source) => total + (source.promptCount ?? source.prompts?.length ?? 0),
    0,
  );
  const activeToolCalls = activeSources.reduce(
    (total, source) => total + (source.toolCallCount ?? source.replay?.stats.toolCalls ?? 0),
    0,
  );
  const activityWindowLabel = activityWindow === "today" ? "Today" : "This week";
  const activityDateLabel =
    activityWindow === "today"
      ? now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : `${activityStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const handleOpenReplay = (slug: string) => {
    navigateTo({ view: null, session: slug });
  };

  const handleGenerate = async (source: SourceSession) => {
    setGeneratingSlug(source.slug);
    setGenerateErrorSlug(null);
    try {
      const title = sourceSuggestedTitle(source);
      const resp = await fetchWithRetry("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: source.provider,
          filePaths: source.filePaths,
          toolPaths: source.toolPaths,
          title: normalizeTitleText(title) || undefined,
          sessionSlug: source.slug,
          sessionProject: source.project,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Generation failed");
      navigateTo({ view: null, session: data.slug });
    } catch (err) {
      console.error("Generate error:", err);
      setGenerateErrorSlug(source.slug);
      setTimeout(() => setGenerateErrorSlug((prev) => (prev === source.slug ? null : prev)), 2000);
    } finally {
      setGeneratingSlug(null);
    }
  };

  const submitGenerateFromPopup = async (source: SourceSession, title: string) => {
    setSelectedSlug(null);
    setGeneratingSlug(source.slug);
    setGenerateErrorSlug(null);
    try {
      const resp = await fetchWithRetry("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: source.provider,
          filePaths: source.filePaths,
          toolPaths: source.toolPaths,
          title: normalizeTitleText(title) || undefined,
          sessionSlug: source.slug,
          sessionProject: source.project,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Generation failed");
      navigateTo({ view: null, session: data.slug });
    } catch (err) {
      console.error("Generate error:", err);
      setGenerateErrorSlug(source.slug);
      setTimeout(() => setGenerateErrorSlug((prev) => (prev === source.slug ? null : prev)), 2000);
    } finally {
      setGeneratingSlug(null);
    }
  };

  const handleTitleSave = async (slug: string, title: string) => {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error("Failed to update title");
    setSources((prev) =>
      prev.map((s) =>
        s.slug === slug && s.replay
          ? { ...s, replay: { ...s.replay, title: title || undefined } }
          : s,
      ),
    );
  };

  const handleDeleteReplay = async (slug: string) => {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!resp.ok) return;
      setSources((prev) =>
        prev.map((s) => (s.slug === slug ? { ...s, replay: undefined, existingReplay: null } : s)),
      );
    } catch {
      // ignore
    }
  };

  const doSync = async () => {
    setSyncStatus("syncing");
    setSyncMessage(null);
    try {
      const resp = await fetch("/api/insights/sync", { method: "POST" });
      const data = await resp.json();
      if (resp.status === 401) {
        setSyncStatus("needsLogin");
        setSyncMessage(null);
        return;
      }
      if (!resp.ok || data.error) {
        setSyncStatus("error");
        setSyncMessage(data.error || "Sync failed");
        setTimeout(() => {
          setSyncStatus((s) => (s === "error" ? "idle" : s));
          setSyncMessage(null);
        }, 4000);
      } else {
        setSyncStatus("done");
        setSyncMessage(data.message || `Synced ${data.synced ?? 0} insights`);
        setLastSyncedAt(Date.now());
      }
    } catch {
      setSyncStatus("error");
      setSyncMessage("Network error");
      setTimeout(() => {
        setSyncStatus((s) => (s === "error" ? "idle" : s));
        setSyncMessage(null);
      }, 4000);
    }
  };

  const handleSyncInsights = () => {
    doSync();
  };

  const handleLoginThenSync = async () => {
    setSyncStatus("awaitingLogin");
    setSyncMessage("Waiting for sign in...");
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.url) {
        window.open(data.url, "_blank");
      }
    } catch {
      // fall through — poll will handle it
    }
    // Poll for login completion, then auto-sync
    if (syncPollRef.current) clearInterval(syncPollRef.current);
    if (syncPollTimeoutRef.current) clearTimeout(syncPollTimeoutRef.current);
    syncPollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/auth/get-session");
        const s = await r.json();
        if (s?.session) {
          if (syncPollRef.current) {
            clearInterval(syncPollRef.current);
            syncPollRef.current = null;
          }
          if (syncPollTimeoutRef.current) {
            clearTimeout(syncPollTimeoutRef.current);
            syncPollTimeoutRef.current = null;
          }
          window.dispatchEvent(new Event("vibe-auth-change"));
          doSync();
        }
      } catch {}
    }, 2000);
    syncPollTimeoutRef.current = setTimeout(
      () => {
        if (syncPollRef.current) {
          clearInterval(syncPollRef.current);
          syncPollRef.current = null;
        }
        setSyncStatus("idle");
        setSyncMessage(null);
      },
      3 * 60 * 1000,
    );
  };

  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
      if (syncPollTimeoutRef.current) clearTimeout(syncPollTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (loadingSources || insights.recentSources.length === 0) return;
    const prioritySessions = insights.recentSources
      .filter((session) => session.provider === "cursor")
      .slice(0, 10);
    if (prioritySessions.length === 0) return;

    const slugs = prioritySessions.map((session) => session.slug);
    const sessionIds = prioritySessions
      .map((session) => session.sessionId)
      .filter(
        (sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0,
      );
    const projects = [...new Set(prioritySessions.map((session) => session.project))].slice(0, 5);
    const signature = JSON.stringify({ slugs });
    if (requestedEnrichmentSignatureRef.current === signature) return;
    requestedEnrichmentSignatureRef.current = signature;

    fetch("/api/sources/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slugs,
        sessionIds,
        projects,
        limit: Math.max(10, prioritySessions.length),
      }),
    }).catch(() => {});
  }, [insights.recentSources, loadingSources]);

  // Tick every 30s to update "synced X ago" relative time
  useEffect(() => {
    if (!lastSyncedAt) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [lastSyncedAt]);

  // Recomputed on every tick (via setTick) to keep relative time fresh
  const syncedAgoLabel = (() => {
    if (!lastSyncedAt) return null;
    const diffMs = Date.now() - lastSyncedAt;
    if (diffMs < 60_000) return "just now";
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  })();
  if (loading && !sources.length && !replays.length) {
    return (
      <div className="flex-1 overflow-auto animate-in fade-in duration-500">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
          <SessionLoadingToast
            title="Fetching local sessions"
            description="Loading cached sessions first, then enriching recent Cursor details in place."
          />
          {/* Overview + activity skeleton */}
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm space-y-4">
            <div className="grid grid-cols-4 gap-6">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-8 w-20 skeleton rounded" />
                  <div className="h-3 w-14 skeleton rounded" />
                </div>
              ))}
            </div>
            {/* Heatmap placeholder */}
            <div className="space-y-1.5 pt-2">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="h-3 skeleton rounded" />
              ))}
            </div>
            <div className="h-9 skeleton rounded" />
          </div>
          {/* Sessions + Replays skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {Array.from({ length: 2 }, (_, col) => (
              <div
                key={col}
                className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="h-3 w-28 skeleton rounded" />
                  <div className="h-3 w-14 skeleton rounded" />
                </div>
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 px-1 py-1">
                    <div className="h-5 w-14 skeleton rounded-full shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div
                        className="h-3.5 skeleton rounded"
                        style={{ width: `${55 + ((i * 19) % 35)}%` }}
                      />
                      <div className="h-2.5 w-20 skeleton rounded" />
                    </div>
                    <div className="h-3 w-12 skeleton rounded shrink-0" />
                  </div>
                ))}
                <div className="h-8 skeleton rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && sources.length === 0 && replays.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-red font-mono text-sm">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-5 space-y-5">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(280px,0.72fr)_minmax(0,1.28fr)] lg:items-stretch">
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="mb-3 flex min-h-7 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                  {activityWindowLabel}
                </h2>
                <span className="text-[10px] font-mono text-terminal-dimmer">
                  {activityDateLabel}
                </span>
                <InfoTooltip>
                  Short-term local activity for the selected window. Use this to see whether recent
                  AI work is still actively flowing before jumping into sessions.
                </InfoTooltip>
              </div>
              <div className="inline-flex h-7 shrink-0 items-center rounded-xl bg-terminal-bg p-0.5 shadow-layer-sm">
                {(["today", "week"] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setActivityWindow(value)}
                    className={`h-6 rounded-lg px-3 text-xs font-sans font-semibold transition-all duration-200 ${
                      activityWindow === value
                        ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                        : "text-terminal-dim hover:text-terminal-text"
                    }`}
                  >
                    {value === "today" ? "Today" : "Week"}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 lg:grid-cols-2">
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={activeSessions} />
                </div>
                <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-terminal-dimmer">
                  sessions
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-blue tabular-nums">
                  <AnimatedValue value={activeProjectCount} />
                </div>
                <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-terminal-dimmer">
                  projects
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={activePrompts} />
                </div>
                <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-terminal-dimmer">
                  turns
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-orange tabular-nums">
                  <AnimatedValue value={activeToolCalls} />
                </div>
                <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-terminal-dimmer">
                  tools
                </div>
              </div>
            </div>
          </div>

          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="mb-3 flex min-h-7 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                  Activity Insights
                </h2>
                <InfoTooltip>
                  Long-term local AI coding totals and contribution-style activity across this
                  machine. Cached data appears first, then provider scans enrich details in place.
                </InfoTooltip>
              </div>
              <div className="inline-flex h-7 shrink-0 items-center rounded-xl bg-terminal-bg p-0.5 shadow-layer-sm">
                <button
                  onClick={() => onNavigate("insights")}
                  className="h-6 rounded-lg px-3 text-xs font-sans font-semibold text-terminal-dim transition-all duration-200 hover:text-terminal-text"
                >
                  Insights
                </button>
                <button
                  onClick={handleSyncInsights}
                  disabled={syncStatus === "syncing" || syncStatus === "awaitingLogin"}
                  className={`h-6 rounded-lg px-3 text-xs font-sans font-semibold transition-all duration-200 disabled:cursor-wait disabled:opacity-50 ${
                    syncStatus === "done"
                      ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                      : syncStatus === "error"
                        ? "bg-terminal-red-subtle text-terminal-red shadow-layer-sm"
                        : "text-terminal-dim hover:text-terminal-text"
                  }`}
                  title={syncMessage || undefined}
                >
                  {syncStatus === "syncing"
                    ? "Syncing..."
                    : syncStatus === "done" && syncedAgoLabel
                      ? `\u2713 ${syncedAgoLabel}`
                      : syncStatus === "error"
                        ? "Failed"
                        : syncStatus === "awaitingLogin"
                          ? "Waiting..."
                          : "\u2191 Sync"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={insights.totalSessions} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest">
                  sessions
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-blue tabular-nums">
                  <AnimatedValue value={displayProjectCount} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest">
                  projects
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={displayTotalPrompts} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest">
                  turns
                </div>
              </div>
              <div className="rounded-lg bg-terminal-bg px-3 py-2">
                <div className="text-xl font-mono font-bold text-terminal-orange tabular-nums">
                  <AnimatedValue value={displayTotalToolCalls} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest">
                  tool calls
                </div>
              </div>
            </div>

            <div className="mt-3 flex-1 rounded-lg bg-terminal-bg/70 p-2.5">
              <ContributionHeatmap
                sessionsPerDay={displaySessionsPerDay}
                weeks={52}
                showLegend={false}
              />
            </div>
          </div>
        </div>

        {(loadingSources || (enrichmentStatus?.running && enrichmentStatus.total > 0)) && (
          <SessionLoadingToast
            status={enrichmentStatus?.running ? enrichmentStatus : null}
            title={
              loadingSources
                ? "Refreshing local session list"
                : "Loading more local session details"
            }
            description={
              loadingSources
                ? "Home is using cached data while local providers refresh in the background."
                : "Recent sessions will update in place as titles, prompt previews, counts, and metrics become available."
            }
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)] gap-3 items-stretch">
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                  Recent Sessions
                </h3>
                <InfoTooltip>
                  Pick up the sessions most likely to need your next action.
                </InfoTooltip>
              </div>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalSessions} total
              </span>
            </div>
            <div className="flex flex-1 flex-col justify-between">
              <RecentSessionsList
                sessions={insights.recentSources}
                isLoading={loadingSources}
                enrichmentStatus={enrichmentStatus}
                onGenerate={handleGenerate}
                onViewReplay={handleOpenReplay}
                onSessionClick={(s) => setSelectedSlug(s.slug)}
                generatingSlug={generatingSlug}
                generateErrorSlug={generateErrorSlug}
              />
            </div>
            <button
              onClick={() => onNavigate("sessions")}
              className="mt-auto w-full py-2 text-xs font-sans font-semibold rounded-lg bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200"
            >
              View all sessions &rarr;
            </button>
          </div>

          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                  Recent Replays
                </h3>
                <InfoTooltip>Open something already generated.</InfoTooltip>
              </div>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalReplays} total
              </span>
            </div>
            <div className="flex flex-1 flex-col justify-between">
              <RecentReplaysList
                replays={insights.recentReplays}
                isLoading={loadingReplays}
                onOpen={handleOpenReplay}
              />
            </div>
            <button
              onClick={() => onNavigate("replays")}
              className="mt-auto w-full py-2 text-xs font-sans font-semibold rounded-lg bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200"
            >
              View all replays &rarr;
            </button>
          </div>
        </div>

        {/* Project shortcuts: fast navigation back into a work context */}
        {showRecentProjectsSkeleton ? (
          <RecentProjectsSkeleton />
        ) : recentProjects.length > 1 ? (
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                  Project Shortcuts
                </h3>
                <InfoTooltip>Jump back into the projects with recent AI work.</InfoTooltip>
              </div>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {displayProjectCount} total
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[...recentProjects]
                .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
                .slice(0, HOME_RECENT_PROJECT_LIMIT)
                .map((p) => {
                  const name = projectName(p.project);
                  return (
                    <button
                      key={p.project}
                      onClick={() => {
                        onNavigate("sessions");
                        setTimeout(() => {
                          navigateTo({ tab: "sessions", project: p.project });
                        }, 50);
                      }}
                      className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-terminal-bg hover:bg-terminal-surface-hover transition-colors text-left group"
                    >
                      <div className="min-w-0">
                        <span className="text-xs font-sans font-medium text-terminal-text truncate block group-hover:text-terminal-green transition-colors">
                          {name}
                        </span>
                        <span className="text-[10px] font-mono text-terminal-dimmer">
                          {p.sessions} session{p.sessions > 1 ? "s" : ""} ·{" "}
                          {timeAgo(p.lastActivity)}
                          {p.durationMs > 0 && ` · ${formatCompactDuration(p.durationMs)}`}
                        </span>
                      </div>
                      {p.cost > 0 && (
                        <span className="text-xs font-mono text-terminal-orange tabular-nums shrink-0">
                          ${p.cost.toFixed(2)}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
            {recentProjects.length > HOME_RECENT_PROJECT_LIMIT && (
              <button
                onClick={() => onNavigate("projects")}
                className="w-full py-2 mt-2 text-xs font-sans font-semibold rounded-lg bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200"
              >
                View all projects &rarr;
              </button>
            )}
          </div>
        ) : null}

        <SystemChecksSection />
      </div>

      {/* Session detail popup */}
      {selectedSession && (
        <SessionDetailPopup
          session={selectedSession}
          onClose={() => setSelectedSlug(null)}
          onGenerate={submitGenerateFromPopup}
          onViewReplay={(slug) => navigateTo({ view: null, session: slug })}
          onArchive={(slug) => {
            fetch(`/api/archive/${slug}`, { method: "POST" }).catch(() => {});
            setSelectedSlug(null);
          }}
          onTitleSave={handleTitleSave}
          onDeleteReplay={handleDeleteReplay}
          isGenerating={generatingSlug === selectedSession.slug}
          isArchived={false}
        />
      )}

      {/* Sync login modal */}
      {(syncStatus === "needsLogin" || syncStatus === "awaitingLogin") && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && syncStatus === "needsLogin") {
              setSyncStatus("idle");
            }
          }}
        >
          <div className="relative bg-terminal-surface border border-terminal-border rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            {/* Close button */}
            {syncStatus === "needsLogin" && (
              <button
                onClick={() => setSyncStatus("idle")}
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors cursor-pointer"
              >
                &times;
              </button>
            )}

            {syncStatus === "needsLogin" ? (
              <>
                <h3 className="text-base font-bold text-terminal-text mb-1">
                  Sync Insights to the Cloud
                </h3>
                <p className="text-xs text-terminal-dim mb-5">
                  Sign in with GitHub to unlock your online dashboard.
                </p>

                {/* Value props */}
                <div className="space-y-3 mb-6">
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-terminal-green/10 flex items-center justify-center text-xs font-bold font-mono text-terminal-green">
                      1
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-terminal-text">
                        Cross-machine dashboard
                      </div>
                      <p className="text-[11px] text-terminal-dim mt-0.5">
                        See all your sessions, costs, and streaks in one place — from any browser.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-terminal-orange/10 flex items-center justify-center text-xs font-bold font-mono text-terminal-orange">
                      2
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-terminal-text">
                        Cost tracking &amp; trends
                      </div>
                      <p className="text-[11px] text-terminal-dim mt-0.5">
                        Track spending by model, spot weekly patterns, and monitor project
                        breakdowns.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-terminal-blue/10 flex items-center justify-center text-xs font-bold font-mono text-terminal-blue">
                      3
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-terminal-text">
                        Share your coding card
                      </div>
                      <p className="text-[11px] text-terminal-dim mt-0.5">
                        Activity heatmaps, streak badges, and project stats — shareable at a glance.
                      </p>
                    </div>
                  </div>
                </div>

                {/* CTA */}
                <button
                  onClick={handleLoginThenSync}
                  className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-[#24292f] hover:bg-[#32383f] text-white text-sm font-semibold transition-colors cursor-pointer border border-white/10"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  Sign in with GitHub
                </button>
                <p className="text-[10px] text-terminal-dim text-center mt-3">
                  We&apos;ll auto-sync your insights right after sign in.
                </p>
              </>
            ) : (
              /* Awaiting login state */
              <div className="text-center py-4">
                <div className="text-2xl mb-3 animate-pulse">&uarr;</div>
                <h3 className="text-base font-bold text-terminal-text mb-1">
                  Waiting for sign in...
                </h3>
                <p className="text-xs text-terminal-dim">
                  Complete GitHub sign in in the browser tab. We&apos;ll auto-sync once you&apos;re
                  in.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
