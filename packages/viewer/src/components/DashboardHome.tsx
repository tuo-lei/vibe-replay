import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSummary, SourceSession } from "../types";
import {
  isCacheFresh,
  navigateTo,
  normalizeTitleText,
  parseCachedList,
  projectName,
  replaySuggestedTitle,
  sourceSuggestedTitle,
  timeAgo,
} from "./dashboard-utils";
import { formatDuration } from "./StatsPanel";

// ─── Types ───────────────────────────────────────────────────────────

interface DashboardHomeProps {
  onNavigate: (view: "sessions" | "replays") => void;
}

interface InsightStats {
  totalSessions: number;
  totalReplays: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalDuration: number;
  providerBreakdown: { provider: string; count: number; label: string }[];
  projectCount: number;
  activityByDay: { date: string; label: string; claude: number; cursor: number }[];
  recentSources: SourceSession[];
  recentReplays: SessionSummary[];
  publishedCount: number;
  replayConversionPct: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatCompactDuration(ms: number): string {
  if (ms === 0) return "0m";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// ─── Data Fetching ───────────────────────────────────────────────────

function useDashboardData() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [replays, setReplays] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
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
          }),
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
            }),
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

  return { sources, replays, loading, error, scanProgress };
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
    if (!src) {
      totalPrompts += r.stats.userPrompts || 0;
      totalToolCalls += r.stats.toolCalls || 0;
    } else if (src.toolCallCount == null) {
      totalToolCalls += r.stats.toolCalls || 0;
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

  // Activity by day (last 28 days) — grouped by provider
  const now = new Date();
  const dayMs = 86400000;
  const activityByDay: InsightStats["activityByDay"] = [];
  for (let i = 27; i >= 0; i--) {
    const dayStart = new Date(now.getTime() - i * dayMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + dayMs);
    const dateStr = dayStart.toISOString().slice(0, 10);
    const dayLabel = dayStart.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    let claude = 0;
    let cursor = 0;
    for (const s of sources) {
      const ts = new Date(s.timestamp);
      if (ts >= dayStart && ts < dayEnd) {
        if (s.provider === "cursor") cursor++;
        else claude++;
      }
    }
    activityByDay.push({ date: dateStr, label: dayLabel, claude, cursor });
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
    activityByDay,
    recentSources: [...sources].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5),
    recentReplays: [...replays].sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 5),
    publishedCount: replays.filter((r) => r.gist?.gistId).length,
    replayConversionPct,
  };
}

// ─── UI Components ───────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  color = "green",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: "green" | "blue" | "orange" | "purple";
  icon: React.ReactNode;
}) {
  const textColor: Record<string, string> = {
    green: "text-terminal-green",
    blue: "text-terminal-blue",
    orange: "text-terminal-orange",
    purple: "text-terminal-purple",
  };
  const bgColor: Record<string, string> = {
    green: "bg-terminal-green-subtle",
    blue: "bg-terminal-blue-subtle",
    orange: "bg-terminal-orange-subtle",
    purple: "bg-terminal-purple-subtle",
  };
  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm hover:bg-terminal-surface-hover transition-colors duration-200">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-sans text-terminal-dim uppercase tracking-wider">{label}</p>
          <p className={`text-2xl font-mono font-bold tabular-nums ${textColor[color]}`}>{value}</p>
          {sub && <p className="text-xs font-mono text-terminal-dimmer">{sub}</p>}
        </div>
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center ${bgColor[color]} opacity-70`}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

function ActivityChart({ data }: { data: InsightStats["activityByDay"] }) {
  const maxVal = Math.max(...data.map((d) => d.claude + d.cursor), 1);
  const hasActivity = data.some((d) => d.claude > 0 || d.cursor > 0);

  const weekLabels = useMemo(() => {
    const labels: { index: number; label: string }[] = [];
    for (let i = 0; i < data.length; i += 7) {
      labels.push({ index: i, label: data[i].label.split(",")[0] });
    }
    return labels;
  }, [data]);

  if (!hasActivity) {
    return (
      <div className="flex items-center justify-center h-full text-terminal-dimmer text-xs font-mono">
        No activity in the last 4 weeks
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex items-stretch gap-px min-h-0">
        {data.map((d) => {
          const total = d.claude + d.cursor;
          const heightPct = Math.max((total / maxVal) * 100, total > 0 ? 4 : 0);
          const claudePct = total > 0 ? (d.claude / total) * 100 : 0;
          const isToday = d.date === new Date().toISOString().slice(0, 10);
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col justify-end h-full group relative"
              title={`${d.label}: ${d.claude} Claude, ${d.cursor} Cursor`}
            >
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                <div className="bg-terminal-surface-2 border border-terminal-border-subtle rounded-lg px-2.5 py-1.5 shadow-layer-md whitespace-nowrap">
                  <div className="text-[10px] font-mono text-terminal-dim">{d.label}</div>
                  {d.claude > 0 && (
                    <div className="text-[10px] font-mono text-terminal-orange">
                      {d.claude} Claude
                    </div>
                  )}
                  {d.cursor > 0 && (
                    <div className="text-[10px] font-mono text-terminal-blue">
                      {d.cursor} Cursor
                    </div>
                  )}
                </div>
              </div>
              <div
                className={`rounded-sm transition-all duration-200 ${isToday ? "ring-1 ring-terminal-orange/30" : ""} ${total > 0 ? "hover:opacity-80" : ""}`}
                style={{
                  height: `${heightPct}%`,
                  minHeight: total > 0 ? "3px" : "0",
                  background:
                    total > 0
                      ? `linear-gradient(to top, var(--orange) ${claudePct}%, var(--blue) ${claudePct}%)`
                      : "transparent",
                  opacity: total > 0 ? 0.7 : 0.1,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center mt-1.5 relative h-4">
        {weekLabels.map((w) => (
          <span
            key={w.index}
            className="absolute text-[9px] font-mono text-terminal-dimmer"
            style={{ left: `${(w.index / data.length) * 100}%` }}
          >
            {w.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ProviderBreakdownCard({ breakdown }: { breakdown: InsightStats["providerBreakdown"] }) {
  const total = breakdown.reduce((sum, b) => sum + b.count, 0);
  const colors: Record<string, { bar: string; text: string }> = {
    "claude-code": { bar: "bg-terminal-orange", text: "text-terminal-orange" },
    cursor: { bar: "bg-terminal-blue", text: "text-terminal-blue" },
  };

  if (breakdown.length === 0) {
    return <div className="text-terminal-dimmer text-xs font-mono">No provider data</div>;
  }

  return (
    <div className="space-y-3">
      {breakdown.map((b) => {
        const pct = total > 0 ? (b.count / total) * 100 : 0;
        const c = colors[b.provider] || { bar: "bg-terminal-dim", text: "text-terminal-dim" };
        return (
          <div key={b.provider} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className={`text-xs font-sans font-medium ${c.text}`}>{b.label}</span>
              <span className="text-xs font-mono text-terminal-dim tabular-nums">
                {b.count} ({Math.round(pct)}%)
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-terminal-surface-2 overflow-hidden">
              <div
                className={`h-full rounded-full ${c.bar} transition-all duration-500`}
                style={{ width: `${pct}%`, opacity: 0.7 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    "claude-code": "bg-terminal-orange-subtle text-terminal-orange",
    cursor: "bg-terminal-blue-subtle text-terminal-blue",
  };
  const cls = colors[provider] || "bg-terminal-surface text-terminal-dim";
  const label = provider === "claude-code" ? "Claude" : provider === "cursor" ? "Cursor" : provider;
  return (
    <span
      className={`text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

function RecentSessionsList({
  sessions,
  onViewAll,
  onGenerate,
  onViewReplay,
  generatingSlug,
}: {
  sessions: SourceSession[];
  onViewAll: () => void;
  onGenerate: (source: SourceSession) => void;
  onViewReplay: (slug: string) => void;
  generatingSlug: string | null;
}) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-6 text-terminal-dimmer text-xs font-mono">
        No sessions found. Start a coding session with Claude Code or Cursor.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sessions.map((s) => {
        const hasReplay = !!s.existingReplay;
        const isGenerating = generatingSlug === s.slug;
        return (
          <div
            key={`${s.provider}-${s.slug}`}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-terminal-surface-hover transition-colors duration-200"
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
                  onClick={() => onViewReplay(s.existingReplay!)}
                  className="h-6 px-2.5 text-[11px] font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 flex items-center gap-1"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <polygon points="4 2 14 8 4 14" />
                  </svg>
                  View
                </button>
              ) : (
                <button
                  onClick={() => onGenerate(s)}
                  disabled={isGenerating}
                  className="h-6 px-2.5 text-[11px] font-sans font-semibold rounded-md bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200 disabled:opacity-50 flex items-center gap-1"
                >
                  {isGenerating ? (
                    <span className="animate-pulse">...</span>
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
        className="w-full py-2 mt-1 text-xs font-sans font-semibold rounded-lg bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
      >
        View all sessions &rarr;
      </button>
    </div>
  );
}

function RecentReplaysList({
  replays,
  onViewAll,
  onOpen,
}: {
  replays: SessionSummary[];
  onViewAll: () => void;
  onOpen: (slug: string) => void;
}) {
  if (replays.length === 0) {
    return (
      <div className="text-center py-6 text-terminal-dimmer text-xs font-mono">
        No replays yet. Generate one from the Sessions tab.
      </div>
    );
  }

  return (
    <div className="space-y-1">
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
        className="w-full py-2 mt-1 text-xs font-sans font-semibold rounded-lg bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
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
}

function SystemChecksSection() {
  const [checks, setChecks] = useState<TC[] | null>(null);
  useEffect(() => {
    fetch("/api/system-checks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { checks: TC[] } | null) => d?.checks && setChecks(d.checks))
      .catch(() => {});
  }, []);
  if (!checks) return null;

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
              className={`w-2 h-2 mt-1 rounded-full shrink-0 ${t.installed ? "bg-terminal-green" : "bg-terminal-dim opacity-40"}`}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-xs font-sans font-medium ${t.installed ? "text-terminal-text" : "text-terminal-dimmer"}`}
                >
                  {t.label}
                </span>
                {t.detail && t.detail !== "authenticated" && t.detail !== "data found" && (
                  <span className="text-[10px] font-mono text-terminal-orange">({t.detail})</span>
                )}
              </div>
              <p className="text-[10px] font-mono text-terminal-dimmer truncate">{t.purpose}</p>
              <p
                className={`text-[10px] font-mono truncate ${t.installed ? "text-terminal-green" : "text-terminal-dimmer"}`}
              >
                {t.installed ? t.version || "ready" : "not found"}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────

const I = ({ c, children }: { c: string; children: React.ReactNode }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={c}
  >
    {children}
  </svg>
);
const SessionsIcon = () => (
  <I c="text-terminal-green">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </I>
);
const ReplaysIcon = () => (
  <I c="text-terminal-blue">
    <polygon points="5 3 19 12 5 21 5 3" />
  </I>
);
const PromptsIcon = () => (
  <I c="text-terminal-orange">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </I>
);
const ToolsIcon = () => (
  <I c="text-terminal-purple">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </I>
);

// ─── Main Component ──────────────────────────────────────────────────

export default function DashboardHome({ onNavigate }: DashboardHomeProps) {
  const { sources, replays, loading, error, scanProgress } = useDashboardData();
  const insights = useMemo(() => computeInsights(sources, replays), [sources, replays]);
  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);

  const handleOpenReplay = (slug: string) => {
    navigateTo({ view: null, session: slug });
  };

  const handleGenerate = async (source: SourceSession) => {
    setGeneratingSlug(source.slug);
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
    } finally {
      setGeneratingSlug(null);
    }
  };

  if (loading && sources.length === 0 && replays.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse mx-auto" />
          <div className="text-sm font-mono text-terminal-dim animate-pulse">
            Loading dashboard...
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

  const hasCounts = sources.every((s) => s.promptCount != null);
  const countsSub = hasCounts
    ? `across ${insights.projectCount} projects`
    : `${sources.filter((s) => s.promptCount != null).length} of ${sources.length} scanned`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {scanProgress != null && (
          <div className="flex items-center gap-2 px-1">
            <div className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
            <span className="text-xs font-mono text-terminal-dim">
              Scanning... {scanProgress} sessions
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            label="Sessions"
            value={insights.totalSessions.toLocaleString()}
            sub={`${insights.projectCount} project${insights.projectCount !== 1 ? "s" : ""}`}
            color="green"
            icon={<SessionsIcon />}
          />
          <MetricCard
            label="Replays"
            value={insights.totalReplays.toLocaleString()}
            sub={insights.publishedCount > 0 ? `${insights.publishedCount} published` : undefined}
            color="blue"
            icon={<ReplaysIcon />}
          />
          <MetricCard
            label="Total Prompts"
            value={insights.totalPrompts.toLocaleString()}
            sub={countsSub}
            color="orange"
            icon={<PromptsIcon />}
          />
          <MetricCard
            label="Tool Calls"
            value={insights.totalToolCalls.toLocaleString()}
            sub={countsSub}
            color="purple"
            icon={<ToolsIcon />}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Activity Chart (2/3 width) */}
          <div className="lg:col-span-2 bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Activity
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-terminal-orange opacity-70" />
                  <span className="text-[10px] font-mono text-terminal-dimmer">Claude</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-terminal-blue opacity-70" />
                  <span className="text-[10px] font-mono text-terminal-dimmer">Cursor</span>
                </div>
              </div>
            </div>
            <div className="h-32">
              <ActivityChart data={insights.activityByDay} />
            </div>
          </div>

          {/* Summary Panel (1/3 width) */}
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm space-y-4">
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
              Summary
            </h3>
            <ProviderBreakdownCard breakdown={insights.providerBreakdown} />
            <div className="pt-2 border-t border-terminal-border-subtle space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-sans text-terminal-dim">Replay coverage</span>
                <span className="text-sm font-mono font-medium text-terminal-green tabular-nums">
                  {Math.round(insights.replayConversionPct)}%
                </span>
              </div>
              {insights.totalDuration > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-sans text-terminal-dim">Total replay time</span>
                  <span className="text-sm font-mono font-medium text-terminal-text tabular-nums">
                    {formatCompactDuration(insights.totalDuration)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Recent Sessions
              </h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalSessions} total
              </span>
            </div>
            <RecentSessionsList
              sessions={insights.recentSources}
              onViewAll={() => onNavigate("sessions")}
              onGenerate={handleGenerate}
              onViewReplay={handleOpenReplay}
              generatingSlug={generatingSlug}
            />
          </div>

          <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
                Recent Replays
              </h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {insights.totalReplays} total
              </span>
            </div>
            <RecentReplaysList
              replays={insights.recentReplays}
              onViewAll={() => onNavigate("replays")}
              onOpen={handleOpenReplay}
            />
          </div>
        </div>

        <SystemChecksSection />
      </div>
    </div>
  );
}
