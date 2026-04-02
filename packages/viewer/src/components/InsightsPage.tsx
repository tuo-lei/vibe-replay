/**
 * InsightsPage — Personal vibe coding insights page.
 *
 * Shows a shareable stats card, GitHub-style activity heatmap, streak/highlights,
 * weekly trend, project breakdown, and model/provider usage.
 *
 * All data comes from the existing ScanInsightsProvider (UserInsights).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, SourceSession } from "../types";
import { formatCompactDuration, parseCachedList } from "./dashboard-utils";
import { useScanInsightsContext } from "./InsightsPanel";
import { formatDuration } from "./StatsPanel";

// ─── Types ──────────────────────────────────────────────────────────

type TimeRange = "7d" | "30d" | "90d" | "all";

interface ComputedStats {
  sessions: number;
  durationMs: number;
  cost: number;
  prompts: number;
  edits: number;
  toolCalls: number;
  projects: number;
}

interface StreakInfo {
  current: number;
  longest: number;
  longestStart?: string;
  longestEnd?: string;
}

interface DayOfWeekStats {
  day: string;
  shortDay: string;
  count: number;
}

interface WeeklyData {
  weekLabel: string;
  sessions: number;
  startDate: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeDays(range: TimeRange): number {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return 0; // all
}

function filterSessionsByRange(
  sessionsPerDay: Record<string, number>,
  range: TimeRange,
): Record<string, number> {
  if (range === "all") return sessionsPerDay;
  const days = rangeDays(range);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = dateKey(cutoff);
  const filtered: Record<string, number> = {};
  for (const [k, v] of Object.entries(sessionsPerDay)) {
    if (k >= cutoffKey) filtered[k] = v;
  }
  return filtered;
}

function computeStats(
  sessionsPerDay: Record<string, number>,
  totalStats: {
    totalDurationMs: number;
    totalCost: number;
    totalPrompts: number;
    totalEdits: number;
    totalToolCalls: number;
    totalSessions: number;
    totalProjects: number;
  },
  range: TimeRange,
): ComputedStats {
  if (range === "all") {
    return {
      sessions: totalStats.totalSessions,
      durationMs: totalStats.totalDurationMs,
      cost: totalStats.totalCost,
      prompts: totalStats.totalPrompts,
      edits: totalStats.totalEdits,
      toolCalls: totalStats.totalToolCalls,
      projects: totalStats.totalProjects,
    };
  }
  // For filtered ranges, count sessions from sessionsPerDay
  const filtered = filterSessionsByRange(sessionsPerDay, range);
  const sessions = Object.values(filtered).reduce((a, b) => a + b, 0);
  const ratio = totalStats.totalSessions > 0 ? sessions / totalStats.totalSessions : 0;
  return {
    sessions,
    durationMs: Math.round(totalStats.totalDurationMs * ratio),
    cost: totalStats.totalCost * ratio,
    prompts: Math.round(totalStats.totalPrompts * ratio),
    edits: Math.round(totalStats.totalEdits * ratio),
    toolCalls: Math.round(totalStats.totalToolCalls * ratio),
    projects: totalStats.totalProjects, // projects don't change by range
  };
}

function computeStreak(sessionsPerDay: Record<string, number>): StreakInfo {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Current streak: count backwards from today
  let current = 0;
  const d = new Date(today);
  while (true) {
    const key = dateKey(d);
    if (sessionsPerDay[key] && sessionsPerDay[key] > 0) {
      current++;
      d.setDate(d.getDate() - 1);
    } else if (current === 0) {
      // Allow checking yesterday if today hasn't started yet
      d.setDate(d.getDate() - 1);
      const yKey = dateKey(d);
      if (sessionsPerDay[yKey] && sessionsPerDay[yKey] > 0) {
        current++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Longest streak: scan all dates
  const sortedDates = Object.keys(sessionsPerDay)
    .filter((k) => sessionsPerDay[k] > 0)
    .sort();
  let longest = 0;
  let longestStart: string | undefined;
  let longestEnd: string | undefined;
  let streakLen = 0;
  let streakStart = "";

  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      streakLen = 1;
      streakStart = sortedDates[i];
    } else {
      const prev = new Date(sortedDates[i - 1]);
      const curr = new Date(sortedDates[i]);
      const diff = (curr.getTime() - prev.getTime()) / DAY_MS;
      if (diff === 1) {
        streakLen++;
      } else {
        if (streakLen > longest) {
          longest = streakLen;
          longestStart = streakStart;
          longestEnd = sortedDates[i - 1];
        }
        streakLen = 1;
        streakStart = sortedDates[i];
      }
    }
  }
  if (streakLen > longest) {
    longest = streakLen;
    longestStart = streakStart;
    longestEnd = sortedDates[sortedDates.length - 1];
  }

  return { current, longest, longestStart, longestEnd };
}

function computeDayOfWeek(sessionsPerDay: Record<string, number>): DayOfWeekStats[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const [k, v] of Object.entries(sessionsPerDay)) {
    if (v > 0) {
      const d = new Date(`${k}T00:00:00`);
      counts[d.getDay()] += v;
    }
  }
  return counts.map((count, i) => ({
    day: DAYS_FULL[i],
    shortDay: DAYS_SHORT[i],
    count,
  }));
}

function computeWeeklyTrend(sessionsPerDay: Record<string, number>, weeks: number): WeeklyData[] {
  const result: WeeklyData[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Find start of current week (Monday)
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const currentMonday = new Date(today.getTime() - mondayOffset * DAY_MS);

  for (let w = weeks - 1; w >= 0; w--) {
    const weekStart = new Date(currentMonday.getTime() - w * 7 * DAY_MS);
    let sessions = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart.getTime() + d * DAY_MS);
      const key = dateKey(day);
      sessions += sessionsPerDay[key] || 0;
    }
    const monthDay = weekStart.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    result.push({
      weekLabel: monthDay,
      sessions,
      startDate: dateKey(weekStart),
    });
  }
  return result;
}

function peakDay(sessionsPerDay: Record<string, number>): { date: string; count: number } | null {
  let max = 0;
  let maxDate = "";
  for (const [k, v] of Object.entries(sessionsPerDay)) {
    if (v > max) {
      max = v;
      maxDate = k;
    }
  }
  return max > 0 ? { date: maxDate, count: max } : null;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 1) return `$${cost.toFixed(2)}`;
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost)}`;
}

function formatCompactNum(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function rangeLabel(range: TimeRange): string {
  if (range === "7d") return "Last 7 Days";
  if (range === "30d") return "Last 30 Days";
  if (range === "90d") return "Last 90 Days";
  return "All Time";
}

// ─── GitHub-style Contribution Heatmap ──────────────────────────────

export function ContributionHeatmap({
  sessionsPerDay,
  weeks = 52,
  showLegend = true,
}: {
  sessionsPerDay: Record<string, number>;
  weeks?: number;
  showLegend?: boolean;
}) {
  const { weekColumns, monthByWeek, maxVal } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // End on Saturday of current week
    const dow = today.getDay();
    const endDate = new Date(today.getTime() + (6 - dow) * DAY_MS);
    const totalDays = weeks * 7;
    const startDate = new Date(endDate.getTime() - (totalDays - 1) * DAY_MS);

    let max = 0;
    const cols: Array<Array<{ date: string; count: number }>> = [];
    const months = new Map<number, string>();
    let lastMonth = -1;

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startDate.getTime() + i * DAY_MS);
      const key = dateKey(d);
      const count = sessionsPerDay[key] || 0;
      const wi = Math.floor(i / 7);
      if (count > max) max = count;
      if (!cols[wi]) cols[wi] = [];
      cols[wi].push({ date: key, count });

      const month = d.getMonth();
      if (month !== lastMonth) {
        months.set(wi, d.toLocaleDateString("en-US", { month: "short" }));
        lastMonth = month;
      }
    }
    return { weekColumns: cols, monthByWeek: months, maxVal: max };
  }, [sessionsPerDay, weeks]);

  const cs = (count: number): { cls: string; style?: React.CSSProperties } => {
    if (count === 0) return { cls: "bg-terminal-border/20 dark:bg-terminal-surface-2" };
    const r = maxVal <= 1 ? 1 : count / maxVal;
    return {
      cls: "bg-terminal-green",
      style: { opacity: r <= 0.25 ? 0.4 : r <= 0.5 ? 0.6 : r <= 0.75 ? 0.8 : 1 },
    };
  };

  return (
    <div className="space-y-1">
      {/* Month labels — same flex-1 structure as grid for alignment */}
      <div className="flex items-end gap-[3px]">
        <div className="shrink-0 w-7" />
        <div className="flex-1 flex gap-[3px] min-w-0">
          {weekColumns.map((_, wi) => (
            <div key={wi} className="flex-1 min-w-0 overflow-visible">
              {monthByWeek.has(wi) && (
                <span className="text-[9px] font-mono text-terminal-dimmer whitespace-nowrap">
                  {monthByWeek.get(wi)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Grid with day labels */}
      <div className="flex gap-[3px]">
        <div className="shrink-0 w-7 flex flex-col gap-[3px]">
          {["", "Mon", "", "Wed", "", "Fri", ""].map((label, i) => (
            <div
              key={i}
              className="flex-1 flex items-center text-[9px] font-mono text-terminal-dimmer leading-none"
            >
              {label}
            </div>
          ))}
        </div>
        <div className="flex-1 flex gap-[3px] min-w-0">
          {weekColumns.map((week, wi) => (
            <div key={wi} className="flex-1 flex flex-col gap-[3px] min-w-0">
              {week.map((cell) => {
                const c = cs(cell.count);
                return (
                  <div
                    key={cell.date}
                    className={`aspect-square rounded-sm ${c.cls} hover:ring-1 hover:ring-terminal-text/30`}
                    style={c.style}
                    title={`${cell.date}: ${cell.count} session${cell.count !== 1 ? "s" : ""}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      {showLegend && (
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <span className="text-[9px] font-mono text-terminal-dimmer">Less</span>
          <div className="w-[10px] h-[10px] rounded-sm bg-terminal-border/20 dark:bg-terminal-surface-2" />
          <div
            className="w-[10px] h-[10px] rounded-sm bg-terminal-green"
            style={{ opacity: 0.4 }}
          />
          <div
            className="w-[10px] h-[10px] rounded-sm bg-terminal-green"
            style={{ opacity: 0.6 }}
          />
          <div
            className="w-[10px] h-[10px] rounded-sm bg-terminal-green"
            style={{ opacity: 0.8 }}
          />
          <div className="w-[10px] h-[10px] rounded-sm bg-terminal-green" />
          <span className="text-[9px] font-mono text-terminal-dimmer">More</span>
        </div>
      )}
    </div>
  );
}

/** Mini heatmap for the share card — last 4 weeks, compact */
function MiniHeatmap({ sessionsPerDay }: { sessionsPerDay: Record<string, number> }) {
  const cells = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDays = 28;
    const result: Array<{ key: string; count: number }> = [];
    let max = 0;
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY_MS);
      const key = dateKey(d);
      const count = sessionsPerDay[key] || 0;
      if (count > max) max = count;
      result.push({ key, count });
    }
    return { cells: result, max };
  }, [sessionsPerDay]);

  const cellStyle = (count: number): { className: string; style?: React.CSSProperties } => {
    if (count === 0) return { className: "bg-terminal-border/20 dark:bg-white/5" };
    const r = cells.max <= 1 ? 1 : count / cells.max;
    const opacity = r <= 0.33 ? 0.45 : r <= 0.66 ? 0.7 : 0.9;
    return { className: "bg-terminal-green", style: { opacity } };
  };

  return (
    <div className="flex gap-[3px] flex-wrap">
      {cells.cells.map((c) => {
        const cs = cellStyle(c.count);
        return (
          <div
            key={c.key}
            className={`w-[10px] h-[10px] rounded-[2px] ${cs.className}`}
            style={cs.style}
          />
        );
      })}
    </div>
  );
}

// ─── Share Card ─────────────────────────────────────────────────────

function ShareCard({
  stats,
  streak,
  bestDay,
  sessionsPerDay,
  range,
  providers,
}: {
  stats: ComputedStats;
  streak: StreakInfo;
  bestDay: DayOfWeekStats | null;
  sessionsPerDay: Record<string, number>;
  range: TimeRange;
  providers: Record<string, number>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  const providerLabel = useMemo(() => {
    const entries = Object.entries(providers);
    if (entries.length === 0) return "";
    entries.sort((a, b) => b[1] - a[1]);
    const labels: Record<string, string> = {
      "claude-code": "Claude Code",
      cursor: "Cursor",
    };
    return entries.map(([k]) => labels[k] || k).join(" + ");
  }, [providers]);

  return (
    <div
      ref={cardRef}
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-terminal-surface via-terminal-bg to-terminal-surface border border-terminal-border p-6 md:p-8 shadow-layer-xl"
    >
      {/* Gradient glow */}
      <div className="absolute -top-20 -right-20 w-64 h-64 bg-terminal-green/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-20 -left-20 w-48 h-48 bg-terminal-blue/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-sans font-bold bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent">
              vibe-replay
            </span>
            <span className="text-[10px] font-mono text-terminal-dimmer px-2 py-0.5 rounded-full bg-terminal-surface-2">
              {rangeLabel(range)}
            </span>
          </div>
          {providerLabel && (
            <span className="text-[10px] font-mono text-terminal-dim">{providerLabel}</span>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-x-8 gap-y-5 mb-6">
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-green tabular-nums">
              {formatCompactNum(stats.sessions)}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              sessions
            </div>
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-text tabular-nums">
              {formatCompactDuration(stats.durationMs)}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              coding
            </div>
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-orange tabular-nums">
              {formatCost(stats.cost)}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              spent
            </div>
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-text tabular-nums">
              {formatCompactNum(stats.prompts)}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              prompts
            </div>
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-blue tabular-nums">
              {formatCompactNum(stats.edits)}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              file edits
            </div>
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-purple tabular-nums">
              {stats.projects}
            </div>
            <div className="text-[10px] font-sans font-medium text-terminal-dim uppercase tracking-wider mt-0.5">
              projects
            </div>
          </div>
        </div>

        {/* Mini heatmap */}
        <div className="mb-4">
          <MiniHeatmap sessionsPerDay={sessionsPerDay} />
        </div>

        {/* Footer highlights */}
        <div className="flex items-center justify-between pt-4 border-t border-terminal-border/30">
          <div className="flex items-center gap-4">
            {streak.current > 0 && (
              <span className="text-xs font-mono text-terminal-dim flex items-center gap-1.5">
                <span className="text-terminal-orange">&#9632;</span>
                {streak.current} day streak
              </span>
            )}
            {bestDay && bestDay.count > 0 && (
              <span className="text-xs font-mono text-terminal-dim">
                Most active: {bestDay.day}s
              </span>
            )}
          </div>
          <span className="text-[10px] font-mono text-terminal-dimmer">vibe-replay.com</span>
        </div>
      </div>
    </div>
  );
}

// ─── Highlight Cards ────────────────────────────────────────────────

function HighlightCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-terminal-surface rounded-xl px-4 py-3.5 shadow-layer-sm hover:bg-terminal-surface-hover transition-colors group">
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none mt-0.5">{icon}</span>
        <div className="min-w-0">
          <div className="text-[10px] font-sans font-bold text-terminal-dim uppercase tracking-widest">
            {label}
          </div>
          <div className="text-lg font-mono font-bold text-terminal-text mt-0.5">{value}</div>
          {sub && <div className="text-[10px] font-mono text-terminal-dimmer mt-0.5">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Weekly Trend Chart ─────────────────────────────────────────────

function WeeklyTrendChart({ data }: { data: WeeklyData[] }) {
  const maxVal = Math.max(...data.map((d) => d.sessions), 1);
  const hasActivity = data.some((d) => d.sessions > 0);

  if (!hasActivity) {
    return (
      <div className="flex items-center justify-center h-full text-terminal-dimmer text-xs font-mono">
        No activity to show
      </div>
    );
  }

  // Compute trend
  const recentWeeks = data.slice(-4);
  const olderWeeks = data.slice(-8, -4);
  const recentAvg =
    recentWeeks.reduce((a, b) => a + b.sessions, 0) / Math.max(recentWeeks.length, 1);
  const olderAvg = olderWeeks.reduce((a, b) => a + b.sessions, 0) / Math.max(olderWeeks.length, 1);
  const trendUp = recentAvg > olderAvg;
  const trendFlat = Math.abs(recentAvg - olderAvg) < 0.5;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-1.5 h-28">
        {data.map((w) => {
          const heightPct = Math.max((w.sessions / maxVal) * 100, w.sessions > 0 ? 6 : 0);
          return (
            <div
              key={w.startDate}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
            >
              {/* Tooltip */}
              <div className="absolute bottom-full mb-1 hidden group-hover:block z-10">
                <div className="bg-terminal-surface-2 border border-terminal-border-subtle rounded-lg px-2 py-1 shadow-layer-md whitespace-nowrap">
                  <div className="text-[10px] font-mono text-terminal-dim">{w.weekLabel}</div>
                  <div className="text-[10px] font-mono text-terminal-green font-bold">
                    {w.sessions} session{w.sessions !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              <div
                className="w-full rounded-md bg-terminal-green hover:opacity-90 transition-all"
                style={{
                  height: `${heightPct}%`,
                  minHeight: w.sessions > 0 ? "4px" : "0",
                  opacity: w.sessions > 0 ? 0.7 : 0,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5 overflow-hidden">
          {data
            .filter((_, i) => i % 2 === 0)
            .map((w) => (
              <span key={w.startDate} className="text-[9px] font-mono text-terminal-dimmer">
                {w.weekLabel}
              </span>
            ))}
        </div>
        {!trendFlat && (
          <span
            className={`text-[10px] font-mono font-bold ${trendUp ? "text-terminal-green" : "text-terminal-orange"}`}
          >
            {trendUp ? "\u2191" : "\u2193"} {trendUp ? "Trending up" : "Slowing down"}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Day-of-Week Chart ──────────────────────────────────────────────

function DayOfWeekChart({ data }: { data: DayOfWeekStats[] }) {
  const maxVal = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="space-y-2">
      {data.map((d) => {
        const pct = maxVal > 0 ? (d.count / maxVal) * 100 : 0;
        return (
          <div key={d.day} className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-terminal-dim w-7 text-right shrink-0">
              {d.shortDay}
            </span>
            <div className="flex-1 h-4 rounded bg-terminal-surface-2 overflow-hidden">
              <div
                className="h-full rounded bg-terminal-green transition-all duration-500"
                style={{ width: `${Math.max(pct, d.count > 0 ? 3 : 0)}%`, opacity: 0.65 }}
              />
            </div>
            <span className="text-[10px] font-mono text-terminal-dim w-6 text-right tabular-nums shrink-0">
              {d.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Top Projects ───────────────────────────────────────────────────

function TopProjectsList({
  projects,
}: {
  projects: Array<{
    project: string;
    sessions: number;
    cost: number;
    prompts: number;
    durationMs: number;
    edits: number;
  }>;
}) {
  if (projects.length === 0) {
    return (
      <div className="text-terminal-dimmer text-xs font-mono py-4 text-center">No project data</div>
    );
  }

  const maxSessions = Math.max(...projects.map((p) => p.sessions), 1);

  return (
    <div className="space-y-2">
      {projects.slice(0, 8).map((p) => {
        const name = p.project.split("/").pop() || p.project;
        const pct = (p.sessions / maxSessions) * 100;
        return (
          <div key={p.project} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-sans font-medium text-terminal-text truncate max-w-[60%]">
                {name}
              </span>
              <span className="text-[10px] font-mono text-terminal-dim tabular-nums">
                {p.sessions} session{p.sessions !== 1 ? "s" : ""}
                {p.cost > 0 && ` · ${formatCost(p.cost)}`}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-terminal-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-terminal-green to-terminal-blue transition-all duration-500"
                style={{ width: `${Math.max(pct, 3)}%`, opacity: 0.65 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Model Breakdown ────────────────────────────────────────────────

function ModelBreakdown({ models }: { models: Record<string, number> }) {
  const entries = useMemo(
    () =>
      Object.entries(models)
        .map(([model, count]) => ({ model: shortModelName(model), count }))
        .sort((a, b) => b.count - a.count),
    [models],
  );
  const total = entries.reduce((a, b) => a + b.count, 0);

  if (entries.length === 0) {
    return (
      <div className="text-terminal-dimmer text-xs font-mono py-4 text-center">No model data</div>
    );
  }

  const colors = [
    "bg-terminal-green",
    "bg-terminal-blue",
    "bg-terminal-orange",
    "bg-terminal-purple",
    "bg-terminal-red",
    "bg-terminal-dim",
  ];

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="h-3 rounded-full bg-terminal-surface-2 overflow-hidden flex">
        {entries.map((e, i) => (
          <div
            key={e.model}
            className={`h-full ${colors[i % colors.length]} transition-all duration-500`}
            style={{ width: `${(e.count / total) * 100}%`, opacity: 0.7 }}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="grid grid-cols-2 gap-2">
        {entries.map((e, i) => (
          <div key={e.model} className="flex items-center gap-2">
            <div
              className={`w-2.5 h-2.5 rounded-sm ${colors[i % colors.length]} shrink-0`}
              style={{ opacity: 0.7 }}
            />
            <span className="text-[11px] font-mono text-terminal-dim truncate">{e.model}</span>
            <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums ml-auto shrink-0">
              {e.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function shortModelName(model: string): string {
  // Strip version suffixes for display
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^(sonnet|opus|haiku)-(\d)/, "$1 $2");
}

// ─── Provider Breakdown ─────────────────────────────────────────────

function ProviderBreakdown({ providers }: { providers: Record<string, number> }) {
  const entries = useMemo(
    () =>
      Object.entries(providers)
        .map(([provider, count]) => ({
          provider,
          label:
            provider === "claude-code"
              ? "Claude Code"
              : provider === "cursor"
                ? "Cursor"
                : provider,
          count,
        }))
        .sort((a, b) => b.count - a.count),
    [providers],
  );
  const total = entries.reduce((a, b) => a + b.count, 0);

  if (entries.length === 0) return null;

  const colors: Record<string, string> = {
    "claude-code": "bg-terminal-orange",
    cursor: "bg-terminal-blue",
  };

  return (
    <div className="space-y-3">
      {entries.map((e) => {
        const pct = total > 0 ? (e.count / total) * 100 : 0;
        return (
          <div key={e.provider} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-sans font-medium text-terminal-text">{e.label}</span>
              <span className="text-xs font-mono text-terminal-dim tabular-nums">
                {e.count} ({Math.round(pct)}%)
              </span>
            </div>
            <div className="h-2 rounded-full bg-terminal-surface-2 overflow-hidden">
              <div
                className={`h-full rounded-full ${colors[e.provider] || "bg-terminal-dim"} transition-all duration-500`}
                style={{ width: `${pct}%`, opacity: 0.7 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function InsightsPageSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-8 space-y-6 animate-pulse">
        {/* Share card skeleton */}
        <div className="rounded-2xl bg-terminal-surface border border-terminal-border/30 p-8 space-y-6">
          <div className="flex justify-between">
            <div className="h-4 w-24 skeleton rounded" />
            <div className="h-3 w-16 skeleton rounded opacity-40" />
          </div>
          <div className="grid grid-cols-3 gap-8">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-8 w-16 skeleton rounded" />
                <div className="h-3 w-12 skeleton rounded opacity-40" />
              </div>
            ))}
          </div>
          <div className="h-3 w-full skeleton rounded opacity-20" />
        </div>
        {/* Heatmap skeleton */}
        <div className="rounded-xl bg-terminal-surface p-6 h-40 skeleton opacity-10" />
        {/* Highlights skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-xl bg-terminal-surface p-4 h-20 skeleton opacity-15" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Source/Replay counts (consistent with homepage) ────────────────

/** Fetch same source + replay data as homepage to ensure consistent totals. */
function useHomePageCounts() {
  const [counts, setCounts] = useState<{
    sessions: number;
    prompts: number;
    toolCalls: number;
    duration: number;
    projects: number;
  } | null>(null);

  const compute = useCallback((sources: SourceSession[], replays: SessionSummary[]) => {
    let totalPrompts = 0;
    let totalToolCalls = 0;
    let totalDuration = 0;
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
        totalToolCalls += replayToolCalls - src.toolCallCount;
      }
      totalDuration += r.stats.durationMs || 0;
    }
    const projects = new Set<string>();
    for (const s of sources) projects.add(s.project);
    for (const r of replays) projects.add(r.project);

    setCounts({
      sessions: sources.length,
      prompts: totalPrompts,
      toolCalls: totalToolCalls,
      duration: totalDuration,
      projects: projects.size,
    });
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/sources/cached")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch("/api/sessions/cached")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([srcPayload, repPayload]) => {
      const sources = parseCachedList<SourceSession>(srcPayload)?.sessions || [];
      const replays = parseCachedList<SessionSummary>(repPayload)?.sessions || [];
      if (sources.length > 0 || replays.length > 0) compute(sources, replays);
    });
  }, [compute]);

  return counts;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function InsightsPage() {
  const { userInsights, loading, scanStatus } = useScanInsightsContext();
  const homePageCounts = useHomePageCounts();
  const [range, setRange] = useState<TimeRange>("all");

  const isScanning = scanStatus?.running && !userInsights;

  const { stats, streak, dayOfWeek, bestDay, peak, weeklyTrend, activeDays, firstSessionDate } =
    useMemo(() => {
      if (!userInsights) {
        return {
          stats: {
            sessions: 0,
            durationMs: 0,
            cost: 0,
            prompts: 0,
            edits: 0,
            toolCalls: 0,
            projects: 0,
          },
          streak: { current: 0, longest: 0 },
          dayOfWeek: [],
          bestDay: null,
          peak: null,
          weeklyTrend: [],
          activeDays: 0,
          firstSessionDate: null,
        };
      }

      const spd = userInsights.sessionsPerDay || {};
      const filtered = filterSessionsByRange(spd, range);
      // Merge scanner totals with homepage counts — use the higher value for each
      // so that insights always shows >= homepage numbers.
      const mergedTotals = {
        ...userInsights,
        totalSessions: Math.max(userInsights.totalSessions, homePageCounts?.sessions ?? 0),
        totalPrompts: Math.max(userInsights.totalPrompts, homePageCounts?.prompts ?? 0),
        totalToolCalls: Math.max(userInsights.totalToolCalls, homePageCounts?.toolCalls ?? 0),
        totalDurationMs: Math.max(userInsights.totalDurationMs, homePageCounts?.duration ?? 0),
        totalProjects: Math.max(userInsights.totalProjects, homePageCounts?.projects ?? 0),
      };
      const s = computeStats(filtered, mergedTotals, range);
      const sk = computeStreak(spd); // always compute streak from all data
      const dow = computeDayOfWeek(filtered);
      const best = [...dow].sort((a, b) => b.count - a.count)[0] || null;
      const pk = peakDay(filtered);
      const wt = computeWeeklyTrend(spd, 12);
      const ad = Object.values(filtered).filter((v) => v > 0).length;
      const first = userInsights.timeRange?.first || null;

      return {
        stats: s,
        streak: sk,
        dayOfWeek: dow,
        bestDay: best,
        peak: pk,
        weeklyTrend: wt,
        activeDays: ad,
        firstSessionDate: first,
      };
    }, [userInsights, range, homePageCounts]);

  if (loading || isScanning || !userInsights) {
    return <InsightsPageSkeleton />;
  }

  const avgPerActiveDay = activeDays > 0 ? (stats.sessions / activeDays).toFixed(1) : "0";
  const avgPromptsPerSession = stats.sessions > 0 ? Math.round(stats.prompts / stats.sessions) : 0;
  const daysSinceFirst = firstSessionDate
    ? Math.floor((Date.now() - new Date(firstSessionDate).getTime()) / DAY_MS)
    : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Header with time range selector */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-sans font-bold text-terminal-text">Your Insights</h1>
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-terminal-surface">
            {(["7d", "30d", "90d", "all"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-[11px] font-mono rounded-md transition-all ${
                  range === r
                    ? "bg-terminal-green-subtle text-terminal-green font-bold"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {r === "all" ? "All" : r}
              </button>
            ))}
          </div>
        </div>

        {/* Share Card */}
        <ShareCard
          stats={stats}
          streak={streak}
          bestDay={bestDay}
          sessionsPerDay={userInsights.sessionsPerDay || {}}
          range={range}
          providers={userInsights.providers || {}}
        />

        {/* Activity Heatmap — always shows full history regardless of range filter */}
        <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider">
              Activity
            </h3>
            {range !== "all" && (
              <span className="text-[9px] font-mono text-terminal-dimmer">Last 52 weeks</span>
            )}
          </div>
          <ContributionHeatmap sessionsPerDay={userInsights.sessionsPerDay || {}} />
        </div>

        {/* Highlights */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <HighlightCard
            icon={"\u{1F525}"}
            label="Current Streak"
            value={`${streak.current} day${streak.current !== 1 ? "s" : ""}`}
            sub={
              streak.longest > streak.current
                ? `Best: ${streak.longest} days`
                : streak.current > 0
                  ? "Personal best!"
                  : undefined
            }
          />
          <HighlightCard
            icon={"\u26A1"}
            label="Avg / Active Day"
            value={`${avgPerActiveDay} sessions`}
            sub={`${activeDays} active day${activeDays !== 1 ? "s" : ""}`}
          />
          <HighlightCard
            icon={"\u{1F4AC}"}
            label="Avg / Session"
            value={`${avgPromptsPerSession} prompts`}
            sub={
              stats.sessions > 0
                ? `~${formatCompactDuration(stats.durationMs / stats.sessions)} each`
                : undefined
            }
          />
          {peak ? (
            <HighlightCard
              icon={"\u{1F3C6}"}
              label="Peak Day"
              value={`${peak.count} sessions`}
              sub={new Date(`${peak.date}T00:00:00`).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            />
          ) : (
            <HighlightCard
              icon={"\u{1F4C5}"}
              label="Vibe Coding Since"
              value={daysSinceFirst > 0 ? `${daysSinceFirst} days` : "Today"}
              sub={
                firstSessionDate
                  ? new Date(firstSessionDate).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : undefined
              }
            />
          )}
        </div>

        {/* Two-column: Weekly Trend + Day of Week */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-4">
              Weekly Trend
            </h3>
            <WeeklyTrendChart data={weeklyTrend} />
          </div>
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-4">
              Day of Week
            </h3>
            <DayOfWeekChart data={dayOfWeek} />
          </div>
        </div>

        {/* Two-column: Top Projects + Models & Providers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-4">
              Top Projects
            </h3>
            <TopProjectsList
              projects={(userInsights.topProjects || []).map((p) => ({
                project: p.project,
                sessions: p.sessions,
                cost: p.cost,
                prompts: p.prompts,
                durationMs: p.durationMs,
                edits: p.edits,
              }))}
            />
          </div>
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm space-y-5">
            <div>
              <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-4">
                Models
              </h3>
              <ModelBreakdown models={userInsights.models || {}} />
            </div>
            {Object.keys(userInsights.providers || {}).length > 1 && (
              <div>
                <h3 className="text-xs font-sans font-semibold text-terminal-text uppercase tracking-wider mb-4">
                  Providers
                </h3>
                <ProviderBreakdown providers={userInsights.providers || {}} />
              </div>
            )}
          </div>
        </div>

        {/* Vibe coding since banner */}
        {daysSinceFirst > 0 && (
          <div className="text-center py-4">
            <span className="text-[11px] font-mono text-terminal-dimmer">
              You've been vibe coding for {daysSinceFirst} day{daysSinceFirst !== 1 ? "s" : ""} ·{" "}
              {formatDuration(stats.durationMs)} total · {formatCompactNum(stats.toolCalls)} tool
              calls
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
