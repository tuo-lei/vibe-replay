/**
 * InsightsPage — Personal vibe coding insights page.
 *
 * Shows a shareable stats card, GitHub-style activity heatmap, streak/highlights,
 * weekly trend, project breakdown, and model/provider usage.
 *
 * Aggregate data comes from ScanInsightsProvider; exact range totals and usage
 * facets use compact per-session rollups from the local dashboard API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  rollupUsage,
  type UsageRollupEntry,
  type UsageRollupSession,
} from "../engine/usage-rollup";
import {
  rollupInsights,
  type InsightsRangeStats,
  type InsightsRollupPayload,
  rangeSince as insightsRangeSince,
} from "../engine/insights-rollup";
import { AnimatedValue } from "../hooks/useAnimatedNumber";
import type { SessionSummary, SourceSession } from "../types";
import { localDayKey } from "../utils/date";
import { DataQualityIndicator } from "./DataQualityIndicator";
import { TokenBreakdownChart, TurnDurationChart } from "./InsightCharts";
import {
  formatCompactAge,
  formatCompactDuration,
  navigateTo,
  parseCachedList,
  projectName,
  providerBarClass,
  providerDisplayName,
  rollupTopProjects,
  shortModelName,
} from "./dashboard-utils";
import { ScanFailureNotice, useScanInsightsContext } from "./InsightsPanel";
import { formatDuration } from "./StatsPanel";

// ─── Types ──────────────────────────────────────────────────────────

type TimeRange = "7d" | "30d" | "90d" | "all";

interface UsageRollupPayload {
  sessions: UsageRollupSession[];
  indexedSessions: number;
  totalSessions: number;
}

type ComputedStats = InsightsRangeStats;

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

// Hoisted from ShareCard so it isn't re-defined on every render (no-unstable-nested-components).
function MetricLabel({ label, title }: { label: string; title?: string }) {
  return (
    <div className="mt-0.5 flex items-center gap-1">
      <div className="ui-section-title">{label}</div>
      {title ? <DataQualityIndicator title={title} className="shrink-0" /> : null}
    </div>
  );
}

// `dateKey` is a viewer-local alias that delegates to the shared helper.
// Keeps callsites terse while guaranteeing a string return (Date input is always valid).
function dateKey(d: Date): string {
  return localDayKey(d)!;
}

function rangeDays(range: TimeRange): number {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return 0; // all
}

/** Start of the selected range as an instant, or undefined for "all". */
const rangeSince = insightsRangeSince;

function filterSessionsByRange(
  sessionsPerDay: Record<string, number>,
  range: TimeRange,
): Record<string, number> {
  if (range === "all") return sessionsPerDay;
  const days = rangeDays(range);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = dateKey(cutoff);
  const filtered: Record<string, number> = {};
  for (const [k, v] of Object.entries(sessionsPerDay)) {
    if (k >= cutoffKey) filtered[k] = v;
  }
  return filtered;
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

function buildAggregateMetricQuality(notes: string[] | undefined): {
  overall?: string;
  duration?: string;
  cost?: string;
} {
  const allNotes = notes?.filter(Boolean) || [];
  const durationNotes = allNotes.filter((note) =>
    /duration estimates|timing data|duration/i.test(note),
  );
  const costNotes = allNotes.filter((note) =>
    /token snapshots|token and cost|cost totals/i.test(note),
  );

  return {
    overall: allNotes.length > 0 ? allNotes.join("\n") : undefined,
    duration:
      durationNotes.length > 0
        ? ["Coding time is approximate for Cursor sessions.", ...durationNotes].join("\n")
        : undefined,
    cost:
      costNotes.length > 0
        ? ["Spend is a lower bound for Cursor sessions, not the full total.", ...costNotes].join(
            "\n",
          )
        : undefined,
  };
}

function splitModelLabels(model: string): string[] {
  return [
    ...new Set(
      model
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
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
  dataQualityNotes,
}: {
  stats: ComputedStats;
  streak: StreakInfo;
  bestDay: DayOfWeekStats | null;
  sessionsPerDay: Record<string, number>;
  range: TimeRange;
  providers: Record<string, number>;
  dataQualityNotes?: string[];
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  const providerLabel = useMemo(() => {
    const entries = Object.entries(providers);
    if (entries.length === 0) return "";
    entries.sort((a, b) => b[1] - a[1]);
    return entries.map(([k]) => providerDisplayName(k)).join(" + ");
  }, [providers]);
  const metricQuality = useMemo(
    () => buildAggregateMetricQuality(dataQualityNotes),
    [dataQualityNotes],
  );

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
            <span className="ui-pill-compact bg-terminal-surface-2 text-terminal-dimmer">
              {rangeLabel(range)}
            </span>
            {metricQuality.overall ? (
              <DataQualityIndicator title={metricQuality.overall} className="shrink-0" />
            ) : null}
          </div>
          {providerLabel && (
            <span className="text-[10px] font-mono text-terminal-dim">{providerLabel}</span>
          )}
        </div>

        {/* Stats grid — 4 columns matching homepage cards */}
        <div className="grid grid-cols-4 gap-x-6 gap-y-5 mb-6">
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-green tabular-nums">
              <AnimatedValue durationMs={500} value={stats.sessions} formatter={formatCompactNum} />
            </div>
            <MetricLabel label="sessions" />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-blue tabular-nums">
              <AnimatedValue durationMs={500} value={stats.replays} formatter={formatCompactNum} />
            </div>
            <MetricLabel label="replays" />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-green tabular-nums">
              <AnimatedValue durationMs={500} value={stats.prompts} formatter={formatCompactNum} />
            </div>
            <MetricLabel label="turns" />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-orange tabular-nums">
              <AnimatedValue
                durationMs={500}
                value={stats.toolCalls}
                formatter={formatCompactNum}
              />
            </div>
            <MetricLabel label="tool calls" />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-text tabular-nums">
              <AnimatedValue
                durationMs={500}
                value={stats.durationMs}
                formatter={(n) => formatCompactDuration(n)}
              />
            </div>
            <MetricLabel label="coding" title={metricQuality.duration} />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-orange tabular-nums">
              <AnimatedValue durationMs={500} value={stats.cost} formatter={(n) => formatCost(n)} />
            </div>
            <MetricLabel label="spent" title={metricQuality.cost} />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-blue tabular-nums">
              <AnimatedValue durationMs={500} value={stats.edits} formatter={formatCompactNum} />
            </div>
            <MetricLabel label="file edits" />
          </div>
          <div>
            <div className="text-2xl md:text-3xl font-mono font-bold text-terminal-purple tabular-nums">
              <AnimatedValue
                durationMs={500}
                value={stats.projects}
                formatter={(n) => Math.round(n).toString()}
              />
            </div>
            <MetricLabel label="projects" />
          </div>
        </div>

        {/* Mini heatmap */}
        <div className="mb-4">
          <MiniHeatmap sessionsPerDay={sessionsPerDay} />
        </div>

        {/* Footer highlights */}
        <div className="flex items-center justify-between pt-4 border-t border-terminal-border/30">
          <div className="flex items-center gap-4">
            {streak.current > 0 && <span className="ui-caption">{streak.current} day streak</span>}
            {bestDay && bestDay.count > 0 && (
              <span className="ui-caption">Most active: {bestDay.day}</span>
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
          <div className="ui-section-title">{label}</div>
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
        const name = projectName(p.project);
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
      (() => {
        const map = new Map<string, number>();
        for (const [model, count] of Object.entries(models)) {
          for (const label of splitModelLabels(model)) {
            const short = shortModelName(label);
            map.set(short, (map.get(short) ?? 0) + count);
          }
        }
        return [...map.entries()]
          .map(([model, count]) => ({ model, count }))
          .sort((a, b) => b.count - a.count);
      })(),
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

// ─── Provider Breakdown ─────────────────────────────────────────────

function ProviderBreakdown({ providers }: { providers: Record<string, number> }) {
  const entries = useMemo(
    () =>
      Object.entries(providers)
        .map(([provider, count]) => ({
          provider,
          label: providerDisplayName(provider),
          count,
        }))
        .sort((a, b) => b.count - a.count),
    [providers],
  );
  const total = entries.reduce((a, b) => a + b.count, 0);

  if (entries.length === 0) return null;

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
                className={`h-full rounded-full ${providerBarClass(e.provider)} transition-all duration-500`}
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
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="h-6 w-32 skeleton rounded" />
          <div className="flex gap-1">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-7 w-10 skeleton rounded-md" />
            ))}
          </div>
        </div>
        {/* Share card skeleton */}
        <div className="rounded-2xl bg-terminal-surface border border-terminal-border/30 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-4 w-20 skeleton rounded" />
              <div className="h-5 w-12 skeleton rounded-md" />
            </div>
            <div className="h-3 w-28 skeleton rounded" />
          </div>
          <div className="grid grid-cols-4 gap-6">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-2">
                <div
                  className="h-7 skeleton rounded"
                  style={{ width: `${45 + ((i * 13) % 40)}%` }}
                />
                <div className="h-3 w-16 skeleton rounded" />
              </div>
            ))}
          </div>
          <div className="h-2.5 w-full skeleton rounded" />
          <div className="flex justify-between">
            <div className="h-3 w-40 skeleton rounded" />
            <div className="h-3 w-24 skeleton rounded" />
          </div>
        </div>
        {/* Activity heatmap skeleton */}
        <div className="rounded-xl bg-terminal-surface p-5 shadow-layer-sm space-y-4">
          <div className="h-3 w-16 skeleton rounded" />
          <div className="space-y-1.5">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-3 skeleton rounded" />
            ))}
          </div>
        </div>
        {/* Highlight cards skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-xl bg-terminal-surface p-4 shadow-layer-sm space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 skeleton rounded" />
                <div className="h-3 w-20 skeleton rounded" />
              </div>
              <div className="h-6 w-24 skeleton rounded" />
              <div className="h-2.5 w-16 skeleton rounded" />
            </div>
          ))}
        </div>
        {/* Weekly Trend + Day of Week skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 2 }, (_, col) => (
            <div key={col} className="rounded-xl bg-terminal-surface p-5 shadow-layer-sm space-y-4">
              <div className="h-3 w-24 skeleton rounded" />
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="h-3 w-8 skeleton rounded shrink-0" />
                    <div
                      className="h-5 skeleton rounded"
                      style={{ width: `${25 + ((i * 17 + col * 31) % 60)}%` }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InsightsLoadingState({
  scanStatus,
  hasCachedInsights,
}: {
  scanStatus:
    | {
        running: boolean;
        scanned: number;
        total: number;
        phase?: "discovering" | "scanning";
        hasCachedResults?: boolean;
        failedProviders?: string[];
      }
    | null
    | undefined;
  hasCachedInsights: boolean;
}) {
  const detail =
    scanStatus?.phase === "discovering"
      ? "Finding sessions across providers and restoring the latest local data."
      : scanStatus?.total
        ? `Refreshing ${scanStatus.scanned}/${scanStatus.total} sessions in the background.`
        : "Preparing your latest session insights.";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-8 space-y-4">
        <div className="rounded-xl border border-terminal-purple/20 bg-terminal-surface px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-sans text-terminal-text">
            <span className="w-2 h-2 rounded-full bg-terminal-purple animate-pulse" />
            <span>
              {hasCachedInsights ? "Refreshing cached insights" : "Loading your insights"}
            </span>
          </div>
          <p className="mt-1 ui-caption">{detail}</p>
        </div>
        <ScanFailureNotice failedProviders={scanStatus?.failedProviders} />
        <InsightsPageSkeleton />
      </div>
    </div>
  );
}

function InsightsRangeLoadingState({
  range,
  onRangeChange,
  loading,
  error,
}: {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  loading: boolean;
  error: boolean;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-sans font-bold text-terminal-text">Your Insights</h1>
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-terminal-surface">
            {(["7d", "30d", "90d", "all"] as TimeRange[]).map((value) => (
              <button
                key={value}
                onClick={() => onRangeChange(value)}
                className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all ${
                  range === value
                    ? "bg-terminal-green-subtle text-terminal-green font-bold"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {value === "all" ? "All" : value}
              </button>
            ))}
          </div>
        </div>
        <output className="block rounded-xl border border-terminal-purple/20 bg-terminal-surface px-4 py-5 text-sm font-sans text-terminal-text">
          <div className="flex items-center gap-2">
            {!error && <span className="w-2 h-2 rounded-full bg-terminal-purple animate-pulse" />}
            <span>
              {loading
                ? `Loading exact ${range} per-session totals...`
                : "Exact range totals are unavailable."}
            </span>
          </div>
          {error && (
            <p className="mt-2 text-xs font-mono text-terminal-dim">
              Refresh the dashboard to retry. All-time totals remain available.
            </p>
          )}
        </output>
      </div>
    </div>
  );
}

// ─── Source/Replay counts (consistent with homepage) ────────────────

/** Fetch same source + replay data as homepage to ensure consistent totals. */
function useHomePageCounts() {
  const [counts, setCounts] = useState<{
    sessions: number;
    replays: number;
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
      replays: replays.length,
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

/**
 * Compact per-session metrics used to compute exact time-range totals locally.
 * Refetch after a background scan finishes; changing the selected range itself
 * remains request-free.
 */
function useInsightsRollup(scanFinishedAt?: string) {
  const [payload, setPayload] = useState<InsightsRollupPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(false);
    fetch("/api/insights/rollup")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Insights rollup request failed: ${r.status}`);
        return (await r.json()) as InsightsRollupPayload;
      })
      .then((data) => {
        if (!Array.isArray(data.sessions) || !Array.isArray(data.replays)) {
          throw new Error("Invalid insights rollup payload");
        }
        if (!stopped) setPayload(data);
      })
      .catch(() => {
        if (!stopped) {
          setPayload(null);
          setError(true);
        }
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [scanFinishedAt]);

  return { payload, loading, error };
}

/**
 * Per-session usage counters for the whole scan. Fetched once and aggregated
 * locally so switching time range costs no request, and refetched when a scan
 * finishes so the section isn't stuck on a stale snapshot.
 */
function useUsageRollupSessions(scanFinishedAt?: string, usageBackfillRunning = false) {
  const [payload, setPayload] = useState<UsageRollupPayload | null>(null);

  useEffect(() => {
    let stopped = false;
    fetch("/api/usage/rollup")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: UsageRollupPayload | null) => {
        if (!stopped && data?.sessions) setPayload(data);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [scanFinishedAt, usageBackfillRunning]);

  return payload;
}

// ─── Tool & MCP Usage ───────────────────────────────────────────────

function encodeUsageFacetValue(name: string): string {
  // URLSearchParams performs the URL encoding. Keep MCP's conventional
  // server/tool slash readable so the resulting query is a normal single
  // facet value rather than a doubly encoded `%252F` sequence.
  return encodeURIComponent(name).replace(/%2F/gi, "/");
}

export function navigateToUsageSessions(facet: "tool" | "mcp" | "mcpTool" | "skill", name: string) {
  navigateTo({
    view: "dashboard",
    session: null,
    tab: "sessions",
    project: null,
    q: null,
    provider: null,
    repo: null,
    tool: null,
    mcp: null,
    mcpTool: null,
    skill: null,
    archived: null,
    agentRuns: null,
    replay: null,
    [facet]: encodeUsageFacetValue(name),
  });
}

export function UsageBarList({
  entries,
  emptyLabel,
  unit,
  onSelect,
}: {
  entries: UsageRollupEntry[];
  emptyLabel: string;
  unit: string;
  onSelect?: (name: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="text-terminal-dimmer text-xs font-mono py-4 text-center">{emptyLabel}</div>
    );
  }

  const max = Math.max(...entries.map((e) => e.calls), 1);

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <button
          key={entry.name}
          type="button"
          disabled={!onSelect}
          onClick={() => onSelect?.(entry.name)}
          title={onSelect ? `View sessions using ${entry.name}` : undefined}
          aria-label={`${entry.name}: ${entry.calls} ${unit} across ${entry.sessions} session${
            entry.sessions === 1 ? "" : "s"
          }${onSelect ? ". View matching sessions" : ""}`}
          className={`w-full text-left space-y-1 rounded-md ${
            onSelect
              ? "cursor-pointer hover:bg-terminal-surface-2/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-terminal-green/50"
              : ""
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className="text-xs font-sans font-medium text-terminal-text truncate max-w-[55%]"
              title={entry.name}
            >
              {entry.name}
            </span>
            <span className="text-[10px] font-mono text-terminal-dim tabular-nums shrink-0">
              {formatCompactNum(entry.calls)} {unit} · {entry.sessions} session
              {entry.sessions !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-terminal-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-terminal-green to-terminal-blue transition-all duration-500"
              style={{ width: `${Math.max((entry.calls / max) * 100, 3)}%`, opacity: 0.65 }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function InsightsPage() {
  const { userInsights, loading, scanStatus } = useScanInsightsContext();
  const homePageCounts = useHomePageCounts();
  const [range, setRange] = useState<TimeRange>("all");
  const {
    payload: insightsRollupPayload,
    loading: insightsRollupLoading,
    error: insightsRollupError,
  } = useInsightsRollup(scanStatus?.finishedAt);

  const isInitialScan = scanStatus?.running && !userInsights;

  const { stats, streak, dayOfWeek, bestDay, peak, weeklyTrend, activeDays, firstSessionDate } =
    useMemo(() => {
      if (!userInsights) {
        return {
          stats: {
            sessions: 0,
            replays: 0,
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
      const s = insightsRollupPayload
        ? rollupInsights(insightsRollupPayload, { since: rangeSince(range) })
        : {
            sessions: userInsights.totalSessions,
            replays: homePageCounts?.replays ?? 0,
            durationMs: userInsights.totalDurationMs,
            cost: userInsights.totalCost,
            prompts: userInsights.totalPrompts,
            edits: userInsights.totalEdits,
            toolCalls: userInsights.totalToolCalls,
            projects: userInsights.totalProjects,
          };
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
    }, [userInsights, range, homePageCounts, insightsRollupPayload]);

  const rolledTopProjects = useMemo(
    () => rollupTopProjects(userInsights?.topProjects || []),
    [userInsights?.topProjects],
  );

  const usagePayload = useUsageRollupSessions(
    scanStatus?.finishedAt,
    scanStatus?.usageBackfill?.running === true,
  );
  const usage = useMemo(
    () => rollupUsage(usagePayload?.sessions || [], { since: rangeSince(range), limit: 8 }),
    [usagePayload, range],
  );

  if (!userInsights && (loading || isInitialScan || scanStatus?.phase === "discovering")) {
    return (
      <InsightsLoadingState
        scanStatus={scanStatus}
        hasCachedInsights={Boolean(scanStatus?.hasCachedResults)}
      />
    );
  }

  if (!userInsights) {
    return <InsightsPageSkeleton />;
  }

  if (range !== "all" && !insightsRollupPayload) {
    return (
      <InsightsRangeLoadingState
        range={range}
        onRangeChange={setRange}
        loading={insightsRollupLoading}
        error={insightsRollupError}
      />
    );
  }

  const avgPerActiveDay = activeDays > 0 ? (stats.sessions / activeDays).toFixed(1) : "0";
  const avgPromptsPerSession = stats.sessions > 0 ? Math.round(stats.prompts / stats.sessions) : 0;
  const daysSinceFirst = firstSessionDate
    ? Math.floor((Date.now() - new Date(firstSessionDate).getTime()) / DAY_MS)
    : 0;
  const currentSourceSessionCount = homePageCounts?.sessions ?? userInsights.totalSessions;
  const pendingSessionDelta = Math.max(0, currentSourceSessionCount - userInsights.totalSessions);
  const showSnapshotNotice = Boolean(scanStatus?.running && scanStatus?.hasCachedResults);
  const snapshotAge = scanStatus?.cachedAt ? formatCompactAge(scanStatus.cachedAt) : "";
  const refreshProgress =
    scanStatus?.total && scanStatus.total > 0
      ? `${Math.min(scanStatus.scanned, scanStatus.total)}/${scanStatus.total}`
      : undefined;

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
                className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all ${
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

        {showSnapshotNotice && (
          <div className="rounded-xl border border-terminal-blue/30 bg-terminal-blue/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-terminal-blue" />
              <div className="space-y-1">
                <div className="text-xs font-sans font-semibold text-terminal-text">
                  Showing cached insights snapshot while the background refresh runs
                </div>
                <div className="text-xs font-mono text-terminal-dim">
                  {snapshotAge
                    ? `Snapshot from ${snapshotAge} ago.`
                    : "Using the latest cached scan."}{" "}
                  {refreshProgress
                    ? `Refreshing ${refreshProgress} sessions now.`
                    : "Refreshing now."}
                </div>
                {pendingSessionDelta > 0 && (
                  <div className="text-xs font-mono text-terminal-dim">
                    Insights currently cover {userInsights.totalSessions} scanned sessions;{" "}
                    {pendingSessionDelta} additional session
                    {pendingSessionDelta === 1 ? "" : "s"} will appear after the refresh completes.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <ScanFailureNotice failedProviders={scanStatus?.failedProviders} />

        {/* Share Card */}
        <ShareCard
          stats={stats}
          streak={streak}
          bestDay={bestDay}
          sessionsPerDay={userInsights.sessionsPerDay || {}}
          range={range}
          providers={userInsights.providers || {}}
          dataQualityNotes={userInsights.dataQuality?.notes}
        />

        {/* Activity Heatmap — always shows full history regardless of range filter */}
        <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="ui-section-title-strong">Activity</h3>
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

        {/* Turn Duration Distribution + Token Breakdown */}
        {(userInsights.turnDurationHistogram || userInsights.tokenBreakdown) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {userInsights.turnDurationHistogram && (
              <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
                <h3 className="ui-section-title-strong mb-4">Turn Duration Distribution</h3>
                <TurnDurationChart histogram={userInsights.turnDurationHistogram} />
              </div>
            )}
            {userInsights.tokenBreakdown && (
              <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
                <h3 className="ui-section-title-strong mb-4">Token Usage</h3>
                <TokenBreakdownChart breakdown={userInsights.tokenBreakdown} />
              </div>
            )}
          </div>
        )}

        {/* Tool & MCP usage — aggregated from per-session usage counters */}
        {usage.sessionCount > 0 && (
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm space-y-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="ui-section-title-strong">Tools &amp; MCP</h3>
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {formatCompactNum(usage.toolCalls)} tool · {formatCompactNum(usage.mcpCalls)} MCP
                calls
                {usage.errorCount > 0 && ` · ${formatCompactNum(usage.errorCount)} failed`}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <h4 className="ui-section-title mb-3">Top tools</h4>
                <UsageBarList
                  entries={usage.tools}
                  emptyLabel="No tool data"
                  unit="calls"
                  onSelect={(name) => navigateToUsageSessions("tool", name)}
                />
              </div>
              <div>
                <h4 className="ui-section-title mb-3">Top MCP servers</h4>
                <UsageBarList
                  entries={usage.mcpServers}
                  emptyLabel="No MCP data"
                  unit="calls"
                  onSelect={(name) => navigateToUsageSessions("mcp", name)}
                />
              </div>
            </div>
            {usage.mcpTools.length > 0 && (
              <div>
                <h4 className="ui-section-title mb-3">Top MCP tools</h4>
                <UsageBarList
                  entries={usage.mcpTools}
                  emptyLabel="No MCP data"
                  unit="calls"
                  onSelect={(name) => navigateToUsageSessions("mcpTool", name)}
                />
              </div>
            )}
            {usage.skills.length > 0 && (
              <div>
                <h4 className="ui-section-title mb-3">Top skills</h4>
                <UsageBarList
                  entries={usage.skills}
                  emptyLabel="No skill data"
                  unit="activations"
                  onSelect={(name) => navigateToUsageSessions("skill", name)}
                />
              </div>
            )}
            {usagePayload && usagePayload.indexedSessions < usagePayload.totalSessions && (
              <div className="text-[10px] font-mono text-terminal-dimmer">
                Based on {usagePayload.indexedSessions} of {usagePayload.totalSessions} scanned
                sessions — the rest have no usage index yet.
              </div>
            )}
          </div>
        )}

        {/* Two-column: Weekly Trend + Day of Week */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="ui-section-title-strong mb-4">Weekly Trend</h3>
            <WeeklyTrendChart data={weeklyTrend} />
          </div>
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="ui-section-title-strong mb-4">Day of Week</h3>
            <DayOfWeekChart data={dayOfWeek} />
          </div>
        </div>

        {/* Two-column: Top Projects + Models & Providers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-terminal-surface rounded-xl p-5 shadow-layer-sm">
            <h3 className="ui-section-title-strong mb-4">Top Projects</h3>
            <TopProjectsList
              projects={rolledTopProjects.map((p) => ({
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
              <h3 className="ui-section-title-strong mb-4">Models</h3>
              <ModelBreakdown models={userInsights.models || {}} />
            </div>
            {Object.keys(userInsights.providers || {}).length > 1 && (
              <div>
                <h3 className="ui-section-title-strong mb-4">Providers</h3>
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
