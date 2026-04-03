/**
 * InsightsPanel — Project-level or user-level aggregated insights header.
 * Shown at the top of the session list in the Dashboard when scan results are available.
 *
 * Also provides ScanInsightsProvider — a singleton context that runs one
 * scan / polling chain for the entire Dashboard, replacing the previous
 * per-tab useScanInsights() hook.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DataQualityIndicator } from "./DataQualityIndicator";
import { CACHE_REFRESH_TTL_MS, isCacheFresh, shortModelName } from "./dashboard-utils";
import { formatDuration } from "./StatsPanel";

// ─── Types (mirror the server scanner types) ────────────────────────

interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository: string;
}

interface BranchInfo {
  branch: string;
  sessionIds: string[];
  prLinks?: PrLink[];
}

interface MemoryFile {
  name: string;
  description?: string;
  type?: string;
  content: string;
}

interface ProjectMemory {
  memoryFiles: MemoryFile[];
  claudeMd?: string;
}

interface ProjectInsights {
  project: string;
  sessionCount: number;
  totalDurationMs: number;
  totalCost: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalEdits: number;
  models: Record<string, number>;
  branches: BranchInfo[];
  hotFiles: Array<{ file: string; editCount: number; sessionCount: number }>;
  subAgentTotal: number;
  apiErrorTotal: number;
  timeRange: { first: string; last: string };
  sessionsPerDay: Record<string, number>;
  avgSessionDurationMs: number;
  memory?: ProjectMemory;
  dataQuality?: {
    notes: string[];
  };
}

interface UserInsights {
  totalSessions: number;
  totalProjects: number;
  totalDurationMs: number;
  totalCost: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalEdits: number;
  providers: Record<string, number>;
  topProjects: Array<{
    project: string;
    sessions: number;
    cost: number;
    prompts: number;
    durationMs: number;
    toolCalls: number;
    edits: number;
    branchCount: number;
    prCount: number;
    memoryFileCount: number;
    lastActivity: string;
    sessionsPerDay: Record<string, number>;
  }>;
  models: Record<string, number>;
  timeRange: { first: string; last: string };
  sessionsPerDay: Record<string, number>;
  subAgentTotal: number;
  apiErrorTotal: number;
  avgSessionDurationMs: number;
  dataQuality?: {
    notes: string[];
  };
}

interface ScanStatus {
  running: boolean;
  scanned: number;
  total: number;
  resultCount: number;
  currentSession?: string;
  phase?: "discovering" | "scanning";
  startedAt?: string;
  finishedAt?: string;
  hasInsights?: boolean;
  hasCachedResults?: boolean;
  cachedResultCount?: number;
  cachedAt?: string;
}

// ─── Singleton Context Provider ──────────────────────────────────────

interface ScanInsightsContextValue {
  scanStatus: ScanStatus | null;
  userInsights: UserInsights | null;
  projectInsightsCache: Map<string, ProjectInsights>;
  fetchProjectInsights: (project: string) => void;
  loading: boolean;
}

const ScanInsightsContext = createContext<ScanInsightsContextValue | null>(null);

export function useScanInsightsContext(): ScanInsightsContextValue {
  const ctx = useContext(ScanInsightsContext);
  if (!ctx) throw new Error("useScanInsightsContext must be used within ScanInsightsProvider");
  return ctx;
}

/**
 * Single provider that starts ONE background scan and ONE polling chain.
 * All tabs read from the same shared state via useScanInsightsContext().
 */
export function ScanInsightsProvider({ children }: { children: ReactNode }) {
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [userInsights, setUserInsights] = useState<UserInsights | null>(null);
  const [projectInsightsCache] = useState(() => new Map<string, ProjectInsights>());
  const staleCacheRef = useRef(false);
  const [, forceUpdate] = useState(0);
  const [loading, setLoading] = useState(false);
  const fetchedUserRef = useRef(false);

  // Start background scan once, but avoid immediately re-scanning when we already
  // have fresh cached insights/results to show.
  useEffect(() => {
    let stopped = false;
    let refreshTimer: number | undefined;

    const startScan = () => {
      if (stopped) return;
      fetch("/api/scan/start", { method: "POST" }).catch(() => {});
    };

    const scheduleRefresh = async () => {
      try {
        const resp = await fetch("/api/scan/status");
        if (!resp.ok || stopped) return;
        const status = (await resp.json()) as ScanStatus;
        setScanStatus(status);

        if (status.running) return;
        if (!status.hasCachedResults || !isCacheFresh(status.cachedAt, CACHE_REFRESH_TTL_MS)) {
          startScan();
          return;
        }

        const ageMs = Date.now() - new Date(status.cachedAt!).getTime();
        const delayMs = Math.max(1_000, CACHE_REFRESH_TTL_MS - ageMs);
        refreshTimer = window.setTimeout(startScan, delayMs);
      } catch {
        startScan();
      }
    };

    void scheduleRefresh();

    return () => {
      stopped = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, []);

  // Single polling chain
  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      try {
        const resp = await fetch("/api/scan/status");
        if (!resp.ok || stopped) return null;
        const status = (await resp.json()) as ScanStatus;
        setScanStatus(status);
        return status;
      } catch {
        return null;
      }
    };

    const fetchUserInsights = async () => {
      setLoading(true);
      try {
        const resp = await fetch("/api/insights");
        if (resp.ok) {
          const data = await resp.json();
          if (data.type === "user" && !stopped) {
            setUserInsights(data.insights as UserInsights);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    // Initial poll
    poll().then((status) => {
      if (status?.hasInsights && !fetchedUserRef.current) {
        fetchedUserRef.current = true;
        fetchUserInsights();
      }
    });

    const timer = setInterval(async () => {
      const status = await poll();
      if (!status || stopped) return;

      // Fetch user insights when available (stale data during scan, fresh after)
      if (status.hasInsights && !fetchedUserRef.current) {
        fetchedUserRef.current = true;
        fetchUserInsights();
      }

      // Stop polling when scan completes
      if (!status.running && status.finishedAt) {
        if (status.resultCount > 0) {
          // Mark cache stale so project insights are re-fetched on next access,
          // but keep old entries until overwritten (stale-while-refresh).
          // Flag is cleared after forceUpdate triggers re-renders that call
          // fetchProjectInsights — ensuring all visible tabs get fresh data.
          staleCacheRef.current = true;
          fetchUserInsights();
          forceUpdate((v) => {
            // Clear stale flag after the re-render cycle so all tabs get one fresh fetch
            queueMicrotask(() => {
              staleCacheRef.current = false;
            });
            return v + 1;
          });
        }
        clearInterval(timer);
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchProjectInsights = useCallback(
    (project: string) => {
      // Skip if cached and not stale
      if (projectInsightsCache.has(project) && !staleCacheRef.current) return;
      setLoading(true);
      fetch(`/api/insights?project=${encodeURIComponent(project)}`)
        .then((resp) => (resp.ok ? resp.json() : null))
        .then((data) => {
          if (data?.type === "project") {
            projectInsightsCache.set(project, data.insights as ProjectInsights);
            forceUpdate((v) => v + 1);
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [projectInsightsCache],
  );

  const value = useMemo<ScanInsightsContextValue>(
    () => ({
      scanStatus,
      userInsights,
      projectInsightsCache,
      fetchProjectInsights,
      loading,
    }),
    [scanStatus, userInsights, projectInsightsCache, fetchProjectInsights, loading],
  );

  return <ScanInsightsContext.Provider value={value}>{children}</ScanInsightsContext.Provider>;
}

// ─── Scan progress bar ──────────────────────────────────────────────

export function ScanProgressBar({ status }: { status: ScanStatus }) {
  if (!status.running) return null;
  const pct = status.total > 0 ? Math.round((status.scanned / status.total) * 100) : 0;
  const label =
    status.phase === "discovering"
      ? "Discovering sessions..."
      : status.total > 0
        ? `Refreshing insights... ${status.scanned}/${status.total}`
        : "Preparing insights refresh...";
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-mono bg-terminal-surface text-terminal-dim shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-terminal-purple animate-pulse" />
      <span>{label}</span>
      {status.hasCachedResults && (
        <span className="text-[10px] text-terminal-dimmer">
          showing {status.cachedResultCount || status.resultCount} cached
        </span>
      )}
      {status.total > 0 && (
        <div className="flex-1 max-w-[120px] h-1 rounded-full bg-terminal-surface-2 overflow-hidden">
          <div
            className="h-full bg-terminal-purple rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Metric card ────────────────────────────────────────────────────

function Metric({
  label,
  value,
  sub,
  color = "text-terminal-text",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <div className={`text-base font-mono font-medium tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-wider mt-0.5">
        {label}
      </div>
      {sub && <div className="text-[10px] font-mono text-terminal-dimmer mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Activity sparkline ─────────────────────────────────────────────

function ActivitySparkline({ sessionsPerDay }: { sessionsPerDay: Record<string, number> }) {
  const data = useMemo(() => {
    const days = Object.keys(sessionsPerDay).sort();
    if (days.length === 0) return [];

    // Fill gaps and get last 30 days
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);

    const result: { day: string; count: number }[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      result.push({ day: key, count: sessionsPerDay[key] || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [sessionsPerDay]);

  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="flex items-end gap-px h-6">
      {data.map((d) => (
        <div
          key={d.day}
          title={`${d.day}: ${d.count} session${d.count !== 1 ? "s" : ""}`}
          className={`w-1.5 rounded-sm transition-all ${d.count > 0 ? "bg-terminal-green" : "bg-terminal-surface-2"}`}
          style={{
            height: d.count > 0 ? `${Math.max(20, (d.count / max) * 100)}%` : "4px",
            opacity: d.count > 0 ? 0.4 + (d.count / max) * 0.6 : 0.3,
          }}
        />
      ))}
    </div>
  );
}

// ─── Project insights panel ─────────────────────────────────────────

export function ProjectInsightsPanel({ insights }: { insights: ProjectInsights }) {
  const [expanded, setExpanded] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const topModel = useMemo(() => {
    const entries = Object.entries(insights.models);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0].replace(/^claude-/, "").split("-202")[0];
  }, [insights.models]);

  const multiBranchSessions = useMemo(() => {
    return insights.branches.filter((b) => b.sessionIds.length > 1);
  }, [insights.branches]);

  // Don't render if there are no sessions
  if (insights.sessionCount === 0) return null;

  return (
    <div className="bg-terminal-surface rounded-xl shadow-layer-sm overflow-hidden">
      {/* Summary row — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-5 py-4 hover:bg-terminal-surface-hover transition-colors duration-200"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-wrap min-w-0">
            <Metric label="Sessions" value={String(insights.sessionCount)} />
            <Metric
              label="Duration"
              value={formatDuration(insights.totalDurationMs)}
              color="text-terminal-blue"
            />
            <Metric
              label="Cost"
              value={`$${insights.totalCost.toFixed(2)}`}
              color="text-terminal-orange"
            />
            <Metric
              label="Prompts"
              value={fmtNum(insights.totalPrompts)}
              color="text-terminal-green"
            />
            <Metric label="Tool calls" value={fmtNum(insights.totalToolCalls)} />
            {insights.totalEdits > 0 && (
              <Metric label="Edits" value={fmtNum(insights.totalEdits)} />
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {topModel && (
              <span className="text-[10px] font-mono px-2 py-1 rounded bg-terminal-surface-2 text-terminal-dim">
                {topModel}
              </span>
            )}
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className={`text-terminal-dim transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            >
              <path d="M3 4.5l3 3 3-3" />
            </svg>
          </div>
        </div>
        {/* Activity sparkline */}
        <div className="mt-3">
          <ActivitySparkline sessionsPerDay={insights.sessionsPerDay} />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] font-mono text-terminal-dimmer">30 days</span>
            <span className="text-[9px] font-mono text-terminal-dimmer">
              avg {formatDuration(insights.avgSessionDurationMs)}/session
            </span>
          </div>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-5 pb-4 space-y-4 border-t border-terminal-border-subtle pt-4">
          {/* Branches & PRs */}
          {insights.branches.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-2">
                Branches ({insights.branches.length})
                {multiBranchSessions.length > 0 && (
                  <span className="ml-1.5 normal-case tracking-normal text-terminal-purple">
                    {multiBranchSessions.length} with multiple sessions
                  </span>
                )}
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {insights.branches.slice(0, 15).map((b) => (
                  <div key={b.branch} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-terminal-purple truncate">{b.branch}</span>
                    <span className="text-terminal-dimmer tabular-nums shrink-0">
                      {b.sessionIds.length} session{b.sessionIds.length > 1 ? "s" : ""}
                    </span>
                    {b.prLinks?.map((pr) => (
                      <a
                        key={pr.prUrl}
                        href={pr.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-terminal-blue hover:underline shrink-0"
                      >
                        #{pr.prNumber}
                      </a>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hot files */}
          {insights.hotFiles.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-2">
                Most modified files
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {insights.hotFiles.slice(0, 10).map((f) => (
                  <div key={f.file} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-terminal-dim truncate flex-1">{f.file}</span>
                    <span className="text-terminal-dimmer tabular-nums shrink-0">
                      {f.editCount}x across {f.sessionCount} session{f.sessionCount > 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Extra stats row */}
          <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
            {insights.subAgentTotal > 0 && (
              <span className="text-terminal-dim">
                Sub-agents: <span className="text-green-300">{insights.subAgentTotal}</span>
              </span>
            )}
            {insights.apiErrorTotal > 0 && (
              <span className="text-terminal-dim">
                API errors: <span className="text-terminal-red">{insights.apiErrorTotal}</span>
              </span>
            )}
            {Object.keys(insights.models).length > 1 && (
              <span className="text-terminal-dim">
                Models:{" "}
                {Object.entries(insights.models)
                  .sort((a, b) => b[1] - a[1])
                  .map(([m, c]) => `${m.replace(/^claude-/, "").split("-202")[0]} (${c})`)
                  .join(", ")}
              </span>
            )}
          </div>

          {/* Memory */}
          {insights.memory && insights.memory.memoryFiles.length > 0 && (
            <div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMemoryOpen((v) => !v);
                }}
                className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-2 flex items-center gap-1 hover:text-terminal-dim transition-colors"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={`transition-transform duration-200 ${memoryOpen ? "rotate-90" : ""}`}
                >
                  <path d="M4.5 2l4 4-4 4" />
                </svg>
                Memory ({insights.memory.memoryFiles.length} files)
              </button>
              {memoryOpen && (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {insights.memory.memoryFiles.map((mf) => (
                    <div
                      key={mf.name}
                      className="bg-terminal-surface-2 rounded-lg px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-terminal-text font-medium">{mf.name}</span>
                        {mf.type && (
                          <span className="px-1.5 py-0.5 rounded bg-terminal-surface text-terminal-dimmer text-[10px]">
                            {mf.type}
                          </span>
                        )}
                      </div>
                      {mf.description && (
                        <div className="text-terminal-dim text-[11px] mb-1">{mf.description}</div>
                      )}
                      <div className="font-mono text-terminal-dimmer whitespace-pre-wrap line-clamp-3 text-[11px] leading-relaxed">
                        {mf.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── User insights panel ────────────────────────────────────────────

export function UserInsightsPanel({ insights }: { insights: UserInsights }) {
  const [expanded, setExpanded] = useState(false);

  if (insights.totalSessions === 0) return null;

  return (
    <div className="bg-terminal-surface rounded-xl shadow-layer-sm overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-5 py-4 hover:bg-terminal-surface-hover transition-colors duration-200"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-wrap min-w-0">
            <Metric label="Sessions" value={String(insights.totalSessions)} />
            <Metric label="Projects" value={String(insights.totalProjects)} />
            <Metric
              label="Duration"
              value={formatDuration(insights.totalDurationMs)}
              color="text-terminal-blue"
            />
            <Metric
              label="Cost"
              value={`$${insights.totalCost.toFixed(2)}`}
              color="text-terminal-orange"
            />
            <Metric
              label="Prompts"
              value={fmtNum(insights.totalPrompts)}
              color="text-terminal-green"
            />
            <Metric label="Tool calls" value={fmtNum(insights.totalToolCalls)} />
          </div>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`text-terminal-dim transition-transform duration-200 shrink-0 ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </div>
        {/* Activity sparkline */}
        <div className="mt-3">
          <ActivitySparkline sessionsPerDay={insights.sessionsPerDay} />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] font-mono text-terminal-dimmer">30 days</span>
            <span className="text-[9px] font-mono text-terminal-dimmer">
              avg {formatDuration(insights.avgSessionDurationMs)}/session
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-4 space-y-4 border-t border-terminal-border-subtle pt-4">
          {/* Top projects */}
          {insights.topProjects.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-2">
                Top projects
              </div>
              <div className="space-y-1.5">
                {insights.topProjects.slice(0, 8).map((p) => {
                  const name = p.project.split("/").pop() || p.project;
                  return (
                    <div key={p.project} className="flex items-center gap-2 text-xs">
                      <span
                        className="font-mono text-terminal-text truncate flex-1"
                        title={p.project}
                      >
                        {name}
                      </span>
                      <span className="text-terminal-dimmer tabular-nums shrink-0">
                        {p.sessions} session{p.sessions > 1 ? "s" : ""}
                      </span>
                      <span className="text-terminal-green tabular-nums shrink-0">
                        {p.prompts} prompts
                      </span>
                      {p.cost > 0 && (
                        <span className="text-terminal-orange tabular-nums shrink-0">
                          ${p.cost.toFixed(2)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Provider + model breakdown */}
          <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
            {Object.keys(insights.providers).length > 0 && (
              <span className="text-terminal-dim">
                Providers:{" "}
                {Object.entries(insights.providers)
                  .sort((a, b) => b[1] - a[1])
                  .map(([p, c]) => `${p} (${c})`)
                  .join(", ")}
              </span>
            )}
            {insights.subAgentTotal > 0 && (
              <span className="text-terminal-dim">
                Sub-agents: <span className="text-green-300">{insights.subAgentTotal}</span>
              </span>
            )}
            {insights.apiErrorTotal > 0 && (
              <span className="text-terminal-dim">
                API errors: <span className="text-terminal-red">{insights.apiErrorTotal}</span>
              </span>
            )}
          </div>

          {/* Edits */}
          {insights.totalEdits > 0 && (
            <div className="text-xs font-mono text-terminal-dim">
              Total edits: <span className="text-terminal-text">{fmtNum(insights.totalEdits)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TitleInsightsHeader — unified title + insights ─────────────────

export function TitleInsightsHeaderSkeleton() {
  return (
    <div className="border-b border-terminal-border-subtle pb-3 animate-pulse">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <div className="h-5 w-36 skeleton rounded" />
          <div className="h-3 w-24 skeleton rounded opacity-40" />
        </div>
        <div className="h-3.5 w-24 skeleton rounded opacity-40" />
      </div>
      <div className="flex items-center gap-5">
        {[16, 14, 10, 12].map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="h-3.5 skeleton rounded" style={{ width: `${w * 4}px` }} />
            <div className="h-2.5 w-10 skeleton rounded opacity-40" />
          </div>
        ))}
        <div className="flex-1" />
        <div className="flex items-end gap-px h-4">
          {Array.from({ length: 30 }, (_, i) => (
            <div
              key={i}
              className="w-1 rounded-sm skeleton"
              style={{ height: `${Math.max(2, Math.random() * 16)}px`, opacity: 0.15 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TitleInsightsHeader({
  insights,
  variant,
}: {
  insights: ProjectInsights | UserInsights;
  variant: "project" | "all";
}) {
  const [expanded, setExpanded] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const isProject = variant === "project";
  const accentColor = isProject ? "text-terminal-green" : "text-terminal-purple";
  const accentDot = isProject ? "bg-terminal-green" : "bg-terminal-purple";
  const pi = isProject ? (insights as ProjectInsights) : null;
  const ui = !isProject ? (insights as UserInsights) : null;

  const sessionCount = pi?.sessionCount ?? ui?.totalSessions ?? 0;
  const totalDurationMs = pi?.totalDurationMs ?? ui?.totalDurationMs ?? 0;
  const totalCost = pi?.totalCost ?? ui?.totalCost ?? 0;
  const totalPrompts = pi?.totalPrompts ?? ui?.totalPrompts ?? 0;
  const totalToolCalls = pi?.totalToolCalls ?? ui?.totalToolCalls ?? 0;
  const totalEdits = pi?.totalEdits ?? ui?.totalEdits ?? 0;
  const models = pi?.models ?? ui?.models ?? {};
  const avgSessionDurationMs = pi?.avgSessionDurationMs ?? ui?.avgSessionDurationMs ?? 0;
  const sessionsPerDay = pi?.sessionsPerDay ?? ui?.sessionsPerDay ?? {};
  const dataQualityNotes = pi?.dataQuality?.notes ?? ui?.dataQuality?.notes ?? [];
  const timeRange = pi?.timeRange ?? ui?.timeRange;

  const title = pi ? pi.project.split("/").pop() || pi.project : "All Projects";
  const subtitle = pi ? pi.project : `${ui?.totalProjects ?? 0} projects`;

  if (sessionCount === 0) return null;

  const modelEntries = Object.entries(models).sort(([, a], [, b]) => b - a);
  const modelsBlock = modelEntries.length > 0 && (
    <div>
      <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-1.5">
        Models
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {modelEntries.map(([model, count]) => (
          <span
            key={model}
            className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim"
            title={model}
          >
            {shortModelName(model)} <span className="text-terminal-dimmer">{count}x</span>
          </span>
        ))}
      </div>
    </div>
  );

  const dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const timeRangeBlock = timeRange && (
    <div className="text-xs font-mono text-terminal-dimmer">
      Active{" "}
      <span className="text-terminal-dim">
        {new Date(timeRange.first).toLocaleDateString("en-US", dateOpts)}
      </span>
      {" — "}
      <span className="text-terminal-dim">
        {new Date(timeRange.last).toLocaleDateString("en-US", dateOpts)}
      </span>
    </div>
  );

  return (
    <div className="border-b border-terminal-border-subtle pb-3">
      {/* Row 1: title + session count */}
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full ${accentDot} shrink-0 self-center`} />
          <h2 className="text-base font-sans font-semibold text-terminal-text truncate">{title}</h2>
          {dataQualityNotes.length > 0 && (
            <DataQualityIndicator title={dataQualityNotes.join("\n")} className="shrink-0" />
          )}
          <span className="text-[10px] font-mono text-terminal-dimmer truncate hidden sm:inline">
            {subtitle}
          </span>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className={`flex items-center gap-1.5 text-xs font-mono tabular-nums shrink-0 hover:text-terminal-text transition-colors ${accentColor}`}
        >
          {sessionCount} session{sessionCount !== 1 ? "s" : ""}
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
      </div>

      {/* Row 2: inline stats + sparkline */}
      <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
        <span className="text-terminal-blue tabular-nums">
          {formatDuration(totalDurationMs)}
          <span className="text-terminal-dimmer ml-1 text-[10px]">duration</span>
        </span>
        {totalCost > 0 && (
          <span className="text-terminal-orange tabular-nums">
            ${totalCost.toFixed(2)}
            <span className="text-terminal-dimmer ml-1 text-[10px]">cost</span>
          </span>
        )}
        <span className="text-terminal-green tabular-nums">
          {fmtNum(totalPrompts)}
          <span className="text-terminal-dimmer ml-1 text-[10px]">prompts</span>
        </span>
        <span className="text-terminal-text tabular-nums">
          {fmtNum(totalToolCalls)}
          <span className="text-terminal-dimmer ml-1 text-[10px]">tools</span>
        </span>
        {totalEdits > 0 && (
          <span className="text-terminal-purple tabular-nums">
            {fmtNum(totalEdits)}
            <span className="text-terminal-dimmer ml-1 text-[10px]">edits</span>
          </span>
        )}
        <span className="text-terminal-dimmer text-[10px] tabular-nums hidden lg:inline">
          avg {formatDuration(avgSessionDurationMs)}/session
        </span>
        {/* Inline sparkline */}
        <div className="flex-1 flex justify-end">
          <div className="flex items-end gap-px h-3.5">
            {(() => {
              const end = new Date();
              const start = new Date(end);
              start.setDate(start.getDate() - 29);
              const bars: { day: string; count: number }[] = [];
              const cursor = new Date(start);
              while (cursor <= end) {
                const key = cursor.toISOString().slice(0, 10);
                bars.push({ day: key, count: sessionsPerDay[key] || 0 });
                cursor.setDate(cursor.getDate() + 1);
              }
              const max = Math.max(...bars.map((b) => b.count), 1);
              return bars.map((b) => (
                <div
                  key={b.day}
                  title={`${b.day}: ${b.count}`}
                  className={`w-1 rounded-sm ${b.count > 0 ? accentDot : "bg-terminal-surface-2"}`}
                  style={{
                    height: b.count > 0 ? `${Math.max(15, (b.count / max) * 100)}%` : "2px",
                    opacity: b.count > 0 ? 0.35 + (b.count / max) * 0.65 : 0.15,
                  }}
                />
              ));
            })()}
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && pi && (
        <div className="mt-3 pt-3 border-t border-terminal-border-subtle space-y-3">
          {pi.branches.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-1.5">
                Branches ({pi.branches.length})
              </div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {pi.branches.slice(0, 15).map((b) => (
                  <div key={b.branch} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-terminal-purple truncate">{b.branch}</span>
                    <span className="text-terminal-dimmer tabular-nums shrink-0">
                      {b.sessionIds.length}x
                    </span>
                    {b.prLinks?.map((pr) => (
                      <a
                        key={pr.prUrl}
                        href={pr.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-terminal-blue hover:underline shrink-0"
                      >
                        #{pr.prNumber}
                      </a>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {pi.hotFiles.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-1.5">
                Most modified files
              </div>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {pi.hotFiles.slice(0, 10).map((f) => (
                  <div key={f.file} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-terminal-dim truncate flex-1">{f.file}</span>
                    <span className="text-terminal-dimmer tabular-nums shrink-0">
                      {f.editCount}x / {f.sessionCount}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {modelsBlock}
          {timeRangeBlock}
          {/* Memory */}
          {pi.memory && pi.memory.memoryFiles.length > 0 && (
            <div>
              <button
                onClick={() => setMemoryOpen((v) => !v)}
                className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-1.5 flex items-center gap-1 hover:text-terminal-dim transition-colors"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={`transition-transform duration-200 ${memoryOpen ? "rotate-90" : ""}`}
                >
                  <path d="M4.5 2l4 4-4 4" />
                </svg>
                Memory ({pi.memory.memoryFiles.length} files)
              </button>
              {memoryOpen && (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {pi.memory.memoryFiles.map((mf) => (
                    <div
                      key={mf.name}
                      className="bg-terminal-surface-2 rounded-lg px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-terminal-text font-medium">{mf.name}</span>
                        {mf.type && (
                          <span className="px-1.5 py-0.5 rounded bg-terminal-surface text-terminal-dimmer text-[10px]">
                            {mf.type}
                          </span>
                        )}
                      </div>
                      {mf.description && (
                        <div className="text-terminal-dim text-[11px] mb-1">{mf.description}</div>
                      )}
                      <div className="font-mono text-terminal-dimmer whitespace-pre-wrap line-clamp-3 text-[11px] leading-relaxed">
                        {mf.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {expanded && ui && (
        <div className="mt-3 pt-3 border-t border-terminal-border-subtle space-y-3">
          {ui.topProjects.length > 0 && (
            <div>
              <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold mb-1.5">
                Top projects
              </div>
              <div className="space-y-1">
                {ui.topProjects.slice(0, 8).map((p) => {
                  const name = p.project.split("/").pop() || p.project;
                  return (
                    <div key={p.project} className="flex items-center gap-2 text-xs">
                      <span
                        className="font-mono text-terminal-text truncate flex-1"
                        title={p.project}
                      >
                        {name}
                      </span>
                      <span className="text-terminal-dimmer tabular-nums shrink-0">
                        {p.sessions}s
                      </span>
                      {p.durationMs > 0 && (
                        <span className="text-terminal-blue tabular-nums shrink-0">
                          {formatDuration(p.durationMs)}
                        </span>
                      )}
                      <span className="text-terminal-green tabular-nums shrink-0">
                        {p.prompts}p
                      </span>
                      {p.edits > 0 && (
                        <span className="text-terminal-purple tabular-nums shrink-0">
                          {p.edits}e
                        </span>
                      )}
                      {p.prCount > 0 && (
                        <span className="text-terminal-blue tabular-nums shrink-0">
                          {p.prCount}pr
                        </span>
                      )}
                      {p.cost > 0 && (
                        <span className="text-terminal-orange tabular-nums shrink-0">
                          ${p.cost.toFixed(2)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {modelsBlock}
          {timeRangeBlock}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
