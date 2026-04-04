import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatedValue } from "../hooks/useAnimatedNumber";
import type { SessionSummary, SourceSession } from "../types";
import { SessionDetailPopup } from "./Dashboard";
import {
  formatCompactDuration,
  isCacheFresh,
  navigateTo,
  normalizeTitleText,
  parseCachedList,
  projectName,
  providerBadgeClass,
  providerBadgeLabel,
  replaySuggestedTitle,
  type SourcesEnrichmentStatus,
  sourceSuggestedTitle,
  timeAgo,
} from "./dashboard-utils";
import { ContributionHeatmap } from "./InsightsPage";
import { useScanInsightsContext } from "./InsightsPanel";
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
  providerBreakdown: { provider: string; count: number; label: string }[];
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
  const [, setEnrichmentStatus] = useState<SourcesEnrichmentStatus | null>(null);
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

      const sourceFresh = isCacheFresh(cachedSources?.cachedAt);
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
              fetch("/api/sources")
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
          fetch("/api/sessions")
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

  // Provider breakdown
  const providerCounts = new Map<string, number>();
  for (const s of sources) {
    providerCounts.set(s.provider, (providerCounts.get(s.provider) || 0) + 1);
  }
  const providerLabels: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor" };
  const providerBreakdown = [...providerCounts.entries()]
    .map(([provider, count]) => ({ provider, count, label: providerLabels[provider] || provider }))
    .sort((a, b) => b.count - a.count);

  // Projects
  const projects = new Set<string>();
  for (const s of sources) projects.add(s.project);
  for (const r of replays) projects.add(r.project);

  // Home activity should reflect the latest discovered sessions immediately,
  // even while richer scan insights are still refreshing in the background.
  const sessionsPerDay: Record<string, number> = {};
  for (const s of sources) {
    const day = s.timestamp?.slice(0, 10);
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
    providerBreakdown,
    projectCount: projects.size,
    sessionsPerDay,
    recentSources: [...sources].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5),
    recentReplays: [...replays].sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 5),
    publishedCount: replays.filter((r) => r.gist?.gistId).length,
    replayConversionPct,
  };
}

// ─── UI Components ───────────────────────────────────────────────────

function RecentProjectsSkeleton() {
  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-28 skeleton rounded" />
        <div className="h-3 w-14 skeleton rounded" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.from({ length: 5 }, (_, i) => (
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

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span
      className={`text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wider ${providerBadgeClass(provider)}`}
    >
      {providerBadgeLabel(provider)}
    </span>
  );
}

function RecentSessionsList({
  sessions,
  isLoading,
  onViewAll,
  onGenerate,
  onViewReplay,
  onSessionClick,
  generatingSlug,
  generateErrorSlug,
}: {
  sessions: SourceSession[];
  isLoading: boolean;
  onViewAll: () => void;
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
          ? "Loading sessions..."
          : "No sessions found. Start a coding session with Claude Code or Cursor."}
      </div>
    );
  }

  return (
    <div className="space-y-1 flex-1 flex flex-col">
      {sessions.map((s) => {
        const hasReplay = !!s.existingReplay;
        const isGenerating = generatingSlug === s.slug;
        const hasError = generateErrorSlug === s.slug;
        return (
          <div
            key={`${s.provider}-${s.slug}`}
            onClick={() => onSessionClick(s)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-terminal-surface-hover transition-colors duration-200 cursor-pointer"
          >
            <ProviderBadge provider={s.provider} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-sans text-terminal-text truncate">
                {sourceSuggestedTitle(s)}
              </p>
              <p className="text-[11px] font-mono text-terminal-dimmer truncate">
                {projectName(s.project)}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-mono text-terminal-dimmer tabular-nums">
                {timeAgo(s.timestamp)}
              </span>
              {hasReplay ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewReplay(s.existingReplay!);
                  }}
                  className="h-7 px-3 text-xs font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 flex items-center gap-1"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <polygon points="4 2 14 8 4 14" />
                  </svg>
                  View
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onGenerate(s);
                  }}
                  disabled={isGenerating}
                  className={`h-7 px-3 text-xs font-sans font-semibold rounded-md transition-all duration-200 disabled:opacity-50 flex items-center gap-1 ${
                    hasError
                      ? "bg-terminal-red-subtle text-terminal-red"
                      : "bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis"
                  }`}
                >
                  {isGenerating ? (
                    <span className="animate-pulse">...</span>
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
              )}
            </div>
          </div>
        );
      })}
      <button
        onClick={onViewAll}
        className="w-full py-2 mt-auto text-xs font-sans font-semibold rounded-lg bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200"
      >
        View all sessions &rarr;
      </button>
    </div>
  );
}

function RecentReplaysList({
  replays,
  isLoading,
  onViewAll,
  onOpen,
}: {
  replays: SessionSummary[];
  isLoading: boolean;
  onViewAll: () => void;
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
      <button
        onClick={onViewAll}
        className="w-full py-2 mt-auto text-xs font-sans font-semibold rounded-lg bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200"
      >
        View all replays &rarr;
      </button>
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

  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
      <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-3">
        System
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {checks.map((t) => (
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
  const { sources, setSources, replays, loading, loadingSources, loadingReplays, error } =
    useDashboardData();
  const insights = useMemo(() => computeInsights(sources, replays), [sources, replays]);
  const { scanStatus, userInsights } = useScanInsightsContext();
  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateErrorSlug, setGenerateErrorSlug] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const selectedSession = selectedSlug
    ? (sources.find((s) => s.slug === selectedSlug) ?? null)
    : null;
  const showRecentProjectsSkeleton =
    !userInsights && (loadingSources || Boolean(scanStatus?.running) || sources.length > 0);
  const displayProjectCount = Math.max(insights.projectCount, userInsights?.totalProjects ?? 0);
  const displayTotalPrompts = userInsights?.totalPrompts ?? insights.totalPrompts;
  const displayTotalToolCalls = userInsights?.totalToolCalls ?? insights.totalToolCalls;
  const displayProviderBreakdown =
    insights.providerBreakdown.length > 0
      ? insights.providerBreakdown
      : Object.entries(userInsights?.providers || {})
          .map(([provider, count]) => ({
            provider,
            count,
            label:
              provider === "claude-code"
                ? "Claude Code"
                : provider === "cursor"
                  ? "Cursor"
                  : provider,
          }))
          .sort((a, b) => b.count - a.count);
  const displaySessionsPerDay =
    Object.keys(insights.sessionsPerDay).length > 0
      ? insights.sessionsPerDay
      : (userInsights?.sessionsPerDay ?? {});

  const handleOpenReplay = (slug: string) => {
    navigateTo({ view: null, session: slug });
  };

  const handleGenerate = async (source: SourceSession) => {
    setGeneratingSlug(source.slug);
    setGenerateErrorSlug(null);
    try {
      const title = sourceSuggestedTitle(source);
      const resp = await fetch("/api/generate", {
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
      const resp = await fetch("/api/generate", {
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

  if (loading && !sources.length && !replays.length) {
    return (
      <div className="flex-1 overflow-auto animate-in fade-in duration-500">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
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
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Combined Overview + Activity */}
        <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
          {/* Compact stats row */}
          <div className="flex items-start justify-between mb-4">
            <div className="grid grid-cols-4 gap-x-6 gap-y-1 flex-1 min-w-0">
              <div>
                <div className="text-2xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={insights.totalSessions} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest mt-0.5">
                  sessions
                </div>
              </div>
              <div>
                <div className="text-2xl font-mono font-bold text-terminal-blue tabular-nums">
                  <AnimatedValue value={insights.totalReplays} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest mt-0.5">
                  replays
                </div>
              </div>
              <div>
                <div className="text-2xl font-mono font-bold text-terminal-green tabular-nums">
                  <AnimatedValue value={displayTotalPrompts} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest mt-0.5">
                  turns
                </div>
              </div>
              <div>
                <div className="text-2xl font-mono font-bold text-terminal-orange tabular-nums">
                  <AnimatedValue value={displayTotalToolCalls} />
                </div>
                <div className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-widest mt-0.5">
                  tool calls
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {displayProviderBreakdown.map((b) => (
                <div
                  key={b.provider}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md ${b.provider === "claude-code" ? "bg-terminal-orange/8" : b.provider === "cursor" ? "bg-terminal-blue/8" : "bg-terminal-dim/8"}`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${b.provider === "claude-code" ? "bg-terminal-orange" : b.provider === "cursor" ? "bg-terminal-blue" : "bg-terminal-dim"}`}
                  />
                  <span
                    className={`text-[10px] font-mono tabular-nums ${b.provider === "claude-code" ? "text-terminal-orange/80" : b.provider === "cursor" ? "text-terminal-blue/80" : "text-terminal-dim"}`}
                  >
                    {b.label}
                  </span>
                  <span
                    className={`text-[10px] font-mono font-bold tabular-nums ${b.provider === "claude-code" ? "text-terminal-orange" : b.provider === "cursor" ? "text-terminal-blue" : "text-terminal-dim"}`}
                  >
                    {b.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Heatmap */}
          <ContributionHeatmap sessionsPerDay={displaySessionsPerDay} weeks={52} />

          {/* CTA link */}
          <button
            onClick={() => onNavigate("insights")}
            className="w-full py-2.5 mt-3 text-xs font-sans font-semibold rounded-lg bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200"
          >
            View personal insights &rarr;
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Recent Sessions
              </h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalSessions} total
              </span>
            </div>
            <div className="flex-1 flex flex-col justify-between">
              <RecentSessionsList
                sessions={insights.recentSources}
                isLoading={loadingSources}
                onViewAll={() => onNavigate("sessions")}
                onGenerate={handleGenerate}
                onViewReplay={handleOpenReplay}
                onSessionClick={(s) => setSelectedSlug(s.slug)}
                generatingSlug={generatingSlug}
                generateErrorSlug={generateErrorSlug}
              />
            </div>
          </div>

          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Recent Replays
              </h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalReplays} total
              </span>
            </div>
            <div className="flex-1 flex flex-col justify-between">
              <RecentReplaysList
                replays={insights.recentReplays}
                isLoading={loadingReplays}
                onViewAll={() => onNavigate("replays")}
                onOpen={handleOpenReplay}
              />
            </div>
          </div>
        </div>

        {/* Recent Projects (below sessions/replays to match tab menu order) */}
        {showRecentProjectsSkeleton ? (
          <RecentProjectsSkeleton />
        ) : userInsights && userInsights.topProjects.length > 1 ? (
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Recent Projects
              </h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {displayProjectCount} total
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[...userInsights.topProjects]
                .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
                .slice(0, 5)
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
                          {p.sessions} session{p.sessions > 1 ? "s" : ""} · {p.prompts} prompts
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
            {userInsights.topProjects.length > 5 && (
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
    </div>
  );
}
