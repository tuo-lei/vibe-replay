/**
 * InsightsPanel — Project-level or user-level aggregated insights header.
 * Shown at the top of the session list in the Dashboard when scan results are available.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
  topProjects: Array<{ project: string; sessions: number; cost: number; prompts: number }>;
  models: Record<string, number>;
  timeRange: { first: string; last: string };
  sessionsPerDay: Record<string, number>;
  subAgentTotal: number;
  apiErrorTotal: number;
  avgSessionDurationMs: number;
}

interface ScanStatus {
  running: boolean;
  scanned: number;
  total: number;
  resultCount: number;
  startedAt?: string;
  finishedAt?: string;
}

// ─── Hook: background scan + insights fetching ──────────────────────

export function useScanInsights() {
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [projectInsights, setProjectInsights] = useState<ProjectInsights | null>(null);
  const [userInsights, setUserInsights] = useState<UserInsights | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Start background scan on mount
  useEffect(() => {
    fetch("/api/scan/start", { method: "POST" }).catch(() => {});
  }, []);

  // Poll scan status
  useEffect(() => {
    const poll = async () => {
      try {
        const resp = await fetch("/api/scan/status");
        if (resp.ok) {
          const status = (await resp.json()) as ScanStatus;
          setScanStatus(status);
          return status;
        }
      } catch {}
      return null;
    };

    poll();
    const timer = setInterval(async () => {
      const status = await poll();
      if (status && !status.running && status.resultCount > 0) {
        clearInterval(timer);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  const fetchInsights = useCallback(
    async (project: string | null) => {
      if (!scanStatus || scanStatus.resultCount === 0) return;
      setLoading(true);
      try {
        const url = project
          ? `/api/insights?project=${encodeURIComponent(project)}`
          : "/api/insights";
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.type === "project") {
          setProjectInsights(data.insights as ProjectInsights);
          setUserInsights(null);
        } else {
          setUserInsights(data.insights as UserInsights);
          setProjectInsights(null);
        }
        setCurrentProject(project);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [scanStatus],
  );

  // Refetch insights when scan finishes
  const scanDone = scanStatus && !scanStatus.running && scanStatus.resultCount > 0;
  useEffect(() => {
    if (scanDone) {
      fetchInsights(currentProject);
    }
  }, [scanDone, fetchInsights, currentProject]);

  return {
    scanStatus,
    projectInsights,
    userInsights,
    loading,
    fetchInsights,
  };
}

// ─── Scan progress bar ──────────────────────────────────────────────

export function ScanProgressBar({ status }: { status: ScanStatus }) {
  if (!status.running || status.total === 0) return null;
  const pct = Math.round((status.scanned / status.total) * 100);
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-mono bg-terminal-surface text-terminal-dim shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-terminal-purple animate-pulse" />
      <span>
        Analyzing sessions... {status.scanned}/{status.total}
      </span>
      <div className="flex-1 max-w-[120px] h-1 rounded-full bg-terminal-surface-2 overflow-hidden">
        <div
          className="h-full bg-terminal-purple rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
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
                Most edited files
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

// ─── Helpers ────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
