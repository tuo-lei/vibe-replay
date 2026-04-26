/**
 * SessionRelationshipsView — alternate Projects tab views:
 *   1. Timeline Swimlane — each project is a horizontal lane, sessions are time blocks
 *   2. File Hotspots     — project-scoped files sorted by repeated edits
 */

import { useEffect, useMemo, useState } from "react";
import { type ScanResultSession, useRelationshipData } from "../hooks/useRelationshipData";
import { isAutomated, sessionScore } from "../utils/sessionSignals";
import {
  cleanPrompt,
  formatDataSourceLabel,
  navigateTo,
  normalizeTitleText,
  projectName,
  providerBadgeLabel,
  rollupProject,
} from "./dashboard-utils";

// ─── Shared helpers ──────────────────────────────────────────────────

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtShortTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function sessionTitle(s: ScanResultSession): string {
  const title = normalizeTitleText(cleanPrompt(s.title || ""));
  if (title) return title;
  const firstPrompt = normalizeTitleText(cleanPrompt(s.firstPrompt || ""));
  return firstPrompt || s.slug;
}

function sessionHasEstimatedTime(s: ScanResultSession): boolean {
  if (s.durationMs == null) return true;
  return (s.dataQualityNotes || []).some((note) =>
    /duration is inferred|duration.*estimated|missing duration/i.test(note),
  );
}

function sessionBadges(s: ScanResultSession): string[] {
  const badges = [providerBadgeLabel(s.provider)];
  const source = s.dataSource ? formatDataSourceLabel(false, s.dataSource) : "";
  if (source) badges.push(source);
  if (sessionHasEstimatedTime(s)) badges.push("estimated time");
  return badges;
}

function rangeEmptyLabel(range: TimelineRange): string {
  switch (range) {
    case "1d":
      return "the last 24 hours";
    case "7d":
      return "the last 7 days";
    case "30d":
      return "the last 30 days";
    case "all":
      return "this scan";
  }
}

// Stable project palette using the same semantic accents as the rest of the dashboard.
const PROJECT_COLORS = [
  {
    bg: "bg-terminal-green/20",
    border: "border-terminal-green",
    text: "text-terminal-green",
    solid: "#22c55e",
  },
  {
    bg: "bg-terminal-blue/20",
    border: "border-terminal-blue",
    text: "text-terminal-blue",
    solid: "#3b82f6",
  },
  {
    bg: "bg-terminal-purple/20",
    border: "border-terminal-purple",
    text: "text-terminal-purple",
    solid: "#a855f7",
  },
  {
    bg: "bg-terminal-orange/20",
    border: "border-terminal-orange",
    text: "text-terminal-orange",
    solid: "#f97316",
  },
  {
    bg: "bg-terminal-cyan/20",
    border: "border-terminal-cyan",
    text: "text-terminal-cyan",
    solid: "#56d4dd",
  },
];

function colorFor(idx: number) {
  return PROJECT_COLORS[idx % PROJECT_COLORS.length];
}

// ─── Group sessions by project ───────────────────────────────────────

interface ProjectGroup {
  project: string;
  sessions: ScanResultSession[];
  totalDurationMs: number;
  totalCost: number;
  lastActivity?: string;
  colorIdx: number;
}

function groupByProject(
  sessions: ScanResultSession[],
  options: { collapseWorktrees?: boolean } = {},
): ProjectGroup[] {
  const map = new Map<string, ScanResultSession[]>();
  for (const s of sessions) {
    const key = options.collapseWorktrees ? rollupProject(s.project) : s.project;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }

  const groups: ProjectGroup[] = [];
  let idx = 0;
  for (const [project, sess] of map) {
    const sorted = [...sess].sort((a, b) => {
      const aStart = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bStart = b.startTime ? new Date(b.startTime).getTime() : 0;
      return bStart - aStart;
    });
    const lastActivityMs = sorted.reduce((max, s) => {
      if (!s.startTime) return max;
      const startMs = new Date(s.startTime).getTime();
      return Math.max(max, activeEndMs(startMs, s));
    }, 0);
    groups.push({
      project,
      sessions: sorted,
      totalDurationMs: sorted.reduce((s, x) => s + (x.durationMs ?? 0), 0),
      totalCost: sorted.reduce((s, x) => s + (x.costEstimate ?? 0), 0),
      lastActivity:
        lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : sorted[0]?.startTime,
      colorIdx: idx++,
    });
  }
  return groups.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

// ─── 1. Timeline View ────────────────────────────────────────────────
//
// One row per project. X position and the bottom wick express active time;
// project color identifies the row. Visual height and min-width make larger
// sessions easier to inspect without also piling on heavy fill/accent channels.
const LANE_GAP_PX = 4;
const MAX_LANES_PER_PROJECT = 5;
const MIN_BAR_HEIGHT_PX = 10;
const MAX_BAR_HEIGHT_PX = 72;
const LABEL_VISIBLE_MIN_HEIGHT_PX = 14;
const LABEL_LINE_HEIGHT_PX = 12;
const LABEL_VERTICAL_PADDING_PX = 6;
const MIN_BAR_MIN_WIDTH_PX = 8;
const MAX_BAR_MIN_WIDTH_PX = 140;
// Approximate width of the time-axis area (px) used to convert minWidthPx into
// a visual end-time for lane packing. Real container is responsive; this is the
// floor we design for. Slightly underestimating makes lanes pack more loosely
// at narrow viewports — better than visual overlap.
const APPROX_TIMELINE_WIDTH_PX = 1100;

interface TimelineSession {
  session: ScanResultSession;
  leftPct: number;
  widthPct: number;
  lane: number;
  score: number;
  minWidthPx: number;
  heightPx: number;
  fillAlpha: number;
  opacity: number;
  realDurationFraction: number;
}

interface TimelineProject {
  project: string;
  sessions: TimelineSession[];
  laneCount: number;
  /** Per-lane height in px — each lane sizes to its tallest bar. */
  laneHeightsPx: number[];
  /** Per-lane top offset (cumulative sum of preceding heights + gaps). */
  laneTopsPx: number[];
  totalRowHeightPx: number;
  hiddenInLanesCount: number; // sessions dropped because they exceeded MAX_LANES_PER_PROJECT
  colorIdx: number;
  lastActivity?: string;
}

function fillAlphaFor(score: number): number {
  return score >= 60 ? 0.24 : 0.16;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function opacityFor(score: number): number {
  return score >= 60 ? 0.95 : 0.78;
}

function minWidthFor(score: number): number {
  const t = Math.sqrt(Math.max(0, Math.min(100, score)) / 100);
  return MIN_BAR_MIN_WIDTH_PX + t * (MAX_BAR_MIN_WIDTH_PX - MIN_BAR_MIN_WIDTH_PX);
}

function heightFor(score: number): number {
  const t = Math.max(0, Math.min(100, score)) / 100;
  return MIN_BAR_HEIGHT_PX + t * (MAX_BAR_HEIGHT_PX - MIN_BAR_HEIGHT_PX);
}

/**
 * Lane packing keeps sessions from overlapping visually while preserving time
 * order. Returns per-session lane index, total lane count, and the number of
 * sessions that couldn't fit within MAX_LANES_PER_PROJECT.
 */
function packTimelineLanes(
  sessions: { startMs: number; endMs: number; score: number; original: ScanResultSession }[],
): { laneAssignments: Map<string, number>; laneCount: number; dropped: number } {
  const ordered = [...sessions].sort((a, b) => a.startMs - b.startMs || b.score - a.score);
  const laneIntervals: Array<Array<{ startMs: number; endMs: number }>> = [];
  const laneAssignments = new Map<string, number>();
  let dropped = 0;

  for (const s of ordered) {
    let placed = -1;
    for (let i = 0; i < laneIntervals.length; i++) {
      const overlap = laneIntervals[i].some((iv) => s.startMs < iv.endMs && s.endMs > iv.startMs);
      if (!overlap) {
        placed = i;
        break;
      }
    }

    if (placed === -1) {
      if (laneIntervals.length >= MAX_LANES_PER_PROJECT) {
        dropped++;
        continue;
      }
      placed = laneIntervals.length;
      laneIntervals.push([]);
    }

    laneIntervals[placed].push({ startMs: s.startMs, endMs: s.endMs });
    laneAssignments.set(s.original.sessionId, placed);
  }

  return { laneAssignments, laneCount: laneIntervals.length, dropped };
}

/**
 * Active end of a session = startTime + durationMs.
 *
 * The raw `endTime` field on a JSONL session is the timestamp of the *last
 * activity*, which can be days or weeks after the session's actual work
 * concluded (Claude Code keeps writing keep-alive entries during long idle
 * gaps). Using it as the visualization endpoint makes a 75-minute session
 * that sat idle for 10 days look like a 10-day-long bar pinned to a window
 * that doesn't actually contain any of its work.
 *
 * Prefer durationMs (real active time). Fall back to endTime - startTime
 * only when duration isn't recorded, and even then cap at 12h to prevent
 * pathological idle gaps from polluting the layout.
 */
function activeEndMs(startMs: number, s: ScanResultSession): number {
  if (s.durationMs != null) return startMs + s.durationMs;
  if (s.endTime) {
    const wallClockMs = new Date(s.endTime).getTime() - startMs;
    return startMs + Math.min(wallClockMs, 12 * 60 * 60 * 1000);
  }
  return startMs + 60_000; // unknown — assume ~1 minute
}

function buildTimeline(
  groups: ProjectGroup[],
  windowStart?: number,
  windowEnd?: number,
  includeAutomated = false,
): {
  projects: TimelineProject[];
  ticks: { leftPct: number; label: string }[];
  minMs: number;
  maxMs: number;
  totalSessions: number;
  hiddenAutomatedCount: number;
} {
  // Determine time bounds. If an explicit window is provided (range selector),
  // use it. Otherwise fall back to min/max across all sessions ("All" view).
  // Use the *active* end (start + durationMs), not raw endTime — see comment
  // on activeEndMs.
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const g of groups) {
    for (const s of g.sessions) {
      if (!s.startTime) continue;
      const startMs = new Date(s.startTime).getTime();
      minMs = Math.min(minMs, startMs);
      maxMs = Math.max(maxMs, activeEndMs(startMs, s));
    }
  }

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) {
    return {
      projects: [],
      ticks: [],
      minMs: 0,
      maxMs: 0,
      totalSessions: 0,
      hiddenAutomatedCount: 0,
    };
  }

  let rangeStart: number;
  let rangeEnd: number;
  if (windowStart != null && windowEnd != null) {
    rangeStart = windowStart;
    rangeEnd = windowEnd;
  } else {
    const totalMs = maxMs - minMs;
    const paddingMs = totalMs * 0.01;
    rangeStart = minMs - paddingMs;
    rangeEnd = maxMs + paddingMs;
  }
  const rangeMs = rangeEnd - rangeStart;

  const projects: TimelineProject[] = [];
  let totalSessions = 0;
  let hiddenAutomatedCount = 0;

  for (const g of groups) {
    // Filter to window + automated policy. Use the *active* end so a session
    // whose JSONL stayed open through 10 days of idle doesn't get pulled into
    // any window its actual work didn't reach.
    const filtered = g.sessions.filter((s) => {
      if (!s.startTime) return false;
      const startMs = new Date(s.startTime).getTime();
      const endMs = activeEndMs(startMs, s);
      if (endMs < rangeStart || startMs > rangeEnd) return false;
      if (!includeAutomated && isAutomated(s)) {
        hiddenAutomatedCount++;
        return false;
      }
      return true;
    });

    if (filtered.length === 0) continue;

    // Build interval list for lane packing. The only visual floor is a small
    // hit target for very short sessions; width otherwise tracks active time.
    const minMsPerPx = rangeMs / APPROX_TIMELINE_WIDTH_PX;
    const intervals = filtered.map((s) => {
      const startMs = new Date(s.startTime!).getTime();
      const realEndMs = activeEndMs(startMs, s);
      const score = sessionScore(s);
      const visualWidthMs = Math.max(realEndMs - startMs, minWidthFor(score) * minMsPerPx);
      return {
        startMs,
        endMs: startMs + visualWidthMs, // visual end for packing
        realEndMs, // for tooltip / display
        score,
        original: s,
      };
    });

    const { laneAssignments, laneCount, dropped } = packTimelineLanes(intervals);

    const tSessions: TimelineSession[] = [];
    for (const it of intervals) {
      const lane = laneAssignments.get(it.original.sessionId);
      if (lane == null) continue; // dropped due to lane cap
      // Clip to viewport: if the bar starts before the visible window, push the
      // left edge to 0 and shorten the width. Avoids "mid-string truncation"
      // where the visible portion starts at some arbitrary character of the title.
      const rawLeftPct = ((it.startMs - rangeStart) / rangeMs) * 100;
      const rawRightPct = ((it.realEndMs - rangeStart) / rangeMs) * 100;
      const leftPct = Math.max(0, rawLeftPct);
      const widthPct = Math.max(0, rawRightPct - leftPct);
      const minWidthPx = minWidthFor(it.score);
      // Compare real-duration width vs. min-width-padded width to figure out
      // how much of the rendered bar is actually "real time" vs. visual reach.
      const realWidthPx = (widthPct / 100) * APPROX_TIMELINE_WIDTH_PX;
      const visualWidthPx = Math.max(realWidthPx, minWidthPx);
      const realDurationFraction = visualWidthPx > 0 ? Math.min(1, realWidthPx / visualWidthPx) : 1;
      tSessions.push({
        session: it.original,
        leftPct,
        widthPct,
        lane,
        score: it.score,
        minWidthPx,
        heightPx: heightFor(it.score),
        fillAlpha: fillAlphaFor(it.score),
        opacity: opacityFor(it.score),
        realDurationFraction,
      });
    }

    if (tSessions.length > 0) {
      tSessions.sort((a, b) => a.leftPct - b.leftPct || b.score - a.score);

      const laneHeightsPx: number[] = Array.from({ length: laneCount }, () => MIN_BAR_HEIGHT_PX);
      for (const ts of tSessions) {
        if (ts.heightPx > laneHeightsPx[ts.lane]) {
          laneHeightsPx[ts.lane] = ts.heightPx;
        }
      }
      const laneTopsPx: number[] = [];
      let cursor = 4;
      for (const h of laneHeightsPx) {
        laneTopsPx.push(cursor);
        cursor += h + LANE_GAP_PX;
      }
      const totalRowHeightPx = cursor + 4;

      projects.push({
        project: g.project,
        sessions: tSessions,
        laneCount,
        laneHeightsPx,
        laneTopsPx,
        totalRowHeightPx,
        hiddenInLanesCount: dropped,
        colorIdx: g.colorIdx,
        lastActivity: g.lastActivity,
      });
      totalSessions += tSessions.length;
    }
  }

  projects.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  // Build time axis ticks (6-8 ticks)
  const tickCount = 7;
  const ticks: { leftPct: number; label: string }[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const ms = rangeStart + (rangeMs * i) / tickCount;
    const d = new Date(ms);
    const leftPct = (i / tickCount) * 100;
    // Smart label: show date if span > 1 day, else just time
    const spanDays = rangeMs / 86400000;
    let label: string;
    if (spanDays > 60) {
      label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    } else if (spanDays > 2) {
      label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } else {
      label = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    ticks.push({ leftPct, label });
  }

  return { projects, ticks, minMs, maxMs, totalSessions, hiddenAutomatedCount };
}

type TimelineRange = "1d" | "7d" | "30d" | "all";

const RANGE_OPTIONS: { value: TimelineRange; label: string; days?: number }[] = [
  { value: "1d", label: "1D", days: 1 },
  { value: "7d", label: "7D", days: 7 },
  { value: "30d", label: "30D", days: 30 },
  { value: "all", label: "All" },
];

function rangeWindow(range: TimelineRange): { start?: number; end?: number } {
  const opt = RANGE_OPTIONS.find((o) => o.value === range);
  if (!opt || opt.days == null) return {};
  const end = Date.now();
  const start = end - opt.days * 86400000;
  return { start, end };
}

interface TooltipInfo {
  session: ScanResultSession;
  x: number;
  y: number;
}

function TimelineSwimlaneView({ groups }: { groups: ProjectGroup[] }) {
  const [range, setRange] = useState<TimelineRange>("7d");
  const [showAutomated, setShowAutomated] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const { start, end } = useMemo(() => rangeWindow(range), [range]);
  const { projects, ticks, totalSessions, hiddenAutomatedCount } = useMemo(
    () => buildTimeline(groups, start, end, showAutomated),
    [groups, start, end, showAutomated],
  );
  const timelineSessions = useMemo(
    () =>
      projects.flatMap((project) =>
        project.sessions.map((session) => ({
          ...session,
          project: project.project,
          colorIdx: project.colorIdx,
        })),
      ),
    [projects],
  );
  const topSessions = useMemo(
    () => [...timelineSessions].sort((a, b) => b.score - a.score).slice(0, 6),
    [timelineSessions],
  );
  const estimatedTimingCount = useMemo(
    () => timelineSessions.filter((ts) => sessionHasEstimatedTime(ts.session)).length,
    [timelineSessions],
  );

  const LABEL_WIDTH = 140;

  return (
    <div className="space-y-4 p-4 select-none">
      {/* Range selector + automated toggle */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="text-sm font-sans font-semibold text-terminal-text">Work Timeline</div>
          <div className="text-xs font-mono text-terminal-dimmer">
            {totalSessions} {plural(totalSessions, "session")} · rows are projects · bar position
            and width show active time
            {estimatedTimingCount > 0 ? ` · ${estimatedTimingCount} estimated` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] font-mono">
          {hiddenAutomatedCount > 0 && !showAutomated && (
            <button
              onClick={() => setShowAutomated(true)}
              className="text-terminal-dimmer hover:text-terminal-text transition-colors"
              title="Scheduled / automated sessions are hidden by default"
            >
              + {hiddenAutomatedCount} automated hidden ▸
            </button>
          )}
          {showAutomated && (
            <button
              onClick={() => setShowAutomated(false)}
              className="text-terminal-purple hover:underline"
            >
              hide automated
            </button>
          )}
          <div className="inline-flex items-center rounded-xl bg-terminal-surface p-0.5 shadow-layer-sm">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`rounded-lg px-2.5 py-1 text-xs font-sans font-semibold transition-all duration-200 ease-material ${
                  range === opt.value
                    ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-terminal-dimmer text-sm font-mono">
          <div>No sessions in {rangeEmptyLabel(range)}.</div>
          {range !== "all" && (
            <button
              onClick={() => setRange("all")}
              className="text-terminal-green hover:underline text-xs"
            >
              Show all sessions →
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="overflow-x-auto rounded-2xl bg-terminal-bg/35 p-3 shadow-inner">
            <div className="min-w-[760px]">
              {/* Time axis header */}
              <div className="flex" style={{ paddingLeft: LABEL_WIDTH }}>
                <div className="relative flex-1 h-6">
                  {ticks.map((t, i) => (
                    <div
                      key={i}
                      className="absolute flex flex-col items-center"
                      style={{ left: `${t.leftPct}%`, transform: "translateX(-50%)" }}
                    >
                      <span className="text-[9px] font-mono text-terminal-dimmer whitespace-nowrap">
                        {t.label}
                      </span>
                      <div className="w-px h-1.5 bg-terminal-border/20 mt-0.5" />
                    </div>
                  ))}
                  <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-terminal-border/25 to-transparent" />
                </div>
              </div>

              {/* Project rows: time stays on x-axis; project color identifies the lane. */}
              <div className="space-y-1.5">
                {projects.map((p) => {
                  const color = colorFor(p.colorIdx);
                  const rowHeight = p.totalRowHeightPx;
                  const accentColor = color.solid;
                  return (
                    <div key={p.project} className="flex items-stretch rounded-xl group">
                      {/* Project label */}
                      <div
                        className="flex flex-col justify-center shrink-0 py-1 pr-3 overflow-hidden"
                        style={{ width: LABEL_WIDTH, height: rowHeight }}
                      >
                        <div className={`text-xs font-sans font-medium truncate ${color.text}`}>
                          {projectName(p.project)}
                        </div>
                        <div className="text-[9px] font-mono text-terminal-dimmer truncate">
                          {p.sessions.length} {plural(p.sessions.length, "session")}
                          {p.hiddenInLanesCount > 0 && (
                            <span className="text-terminal-orange/70">
                              {" "}
                              · +{p.hiddenInLanesCount} hidden
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Lane area */}
                      <div
                        className="relative flex-1 overflow-hidden rounded-xl bg-terminal-surface/45 shadow-layer-sm transition-colors group-hover:bg-terminal-surface-hover/70"
                        style={{ height: rowHeight }}
                      >
                        {/* Grid lines */}
                        {ticks.map((t, i) => (
                          <div
                            key={i}
                            className="absolute top-0 bottom-0 w-px bg-terminal-border/[0.06]"
                            style={{ left: `${t.leftPct}%` }}
                          />
                        ))}

                        {/* Session blocks */}
                        {p.sessions.map((ts) => {
                          const automated = isAutomated(ts.session);
                          const laneTop = p.laneTopsPx[ts.lane];
                          const laneH = p.laneHeightsPx[ts.lane];
                          const top = laneTop + (laneH - ts.heightPx);
                          const opacity = automated ? 0.4 : ts.opacity;
                          const lineClamp = Math.max(
                            1,
                            Math.floor(
                              (ts.heightPx - LABEL_VERTICAL_PADDING_PX) / LABEL_LINE_HEIGHT_PX,
                            ),
                          );
                          const showWick = ts.realDurationFraction < 0.85;
                          return (
                            <button
                              type="button"
                              key={ts.session.sessionId}
                              className="absolute overflow-hidden rounded-md text-left shadow-layer-sm transition-all duration-200 ease-material hover:z-10 hover:shadow-layer-md"
                              style={{
                                left: `${ts.leftPct}%`,
                                // Cap min-width to whatever space is left
                                // between the bar's start and the lane's right
                                // edge — otherwise bars near "today" overflow
                                // the overflow-hidden lane container and get
                                // visually truncated.
                                width: `max(${ts.widthPct}%, min(${ts.minWidthPx}px, calc(100% - ${ts.leftPct}%)))`,
                                top,
                                height: ts.heightPx,
                                opacity,
                                zIndex: automated ? 1 : 2,
                                backgroundColor: hexToRgba(accentColor, ts.fillAlpha),
                              }}
                              aria-label={`Open ${sessionTitle(ts.session)}`}
                              onClick={() => navigateTo({ view: null, session: ts.session.slug })}
                              onMouseEnter={(e) => {
                                setTooltip({
                                  session: ts.session,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                              onMouseLeave={() => setTooltip(null)}
                            >
                              {ts.heightPx >= LABEL_VISIBLE_MIN_HEIGHT_PX && (
                                <span
                                  className={`pointer-events-none block min-w-0 px-1.5 text-[10px] font-mono leading-tight ${color.text} ${
                                    lineClamp === 1
                                      ? "truncate leading-[18px]"
                                      : "overflow-hidden pt-1"
                                  }`}
                                  style={
                                    lineClamp === 1
                                      ? undefined
                                      : {
                                          display: "-webkit-box",
                                          WebkitBoxOrient: "vertical",
                                          WebkitLineClamp: lineClamp,
                                        }
                                  }
                                >
                                  {sessionTitle(ts.session)}
                                </span>
                              )}
                              {showWick && (
                                <>
                                  {/* K-line wick: bright strip along the bottom marks
                                      the actual session duration within the (widened)
                                      bar. Thin enough to coexist with the title above,
                                      bright enough to register against any project
                                      color's fill. */}
                                  <span
                                    className="pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-r-full bg-white/85"
                                    style={{ width: `${ts.realDurationFraction * 100}%` }}
                                    title="actual duration"
                                  />
                                  {/* End-tick at the wick's right edge so the real
                                      end-position is visible even when the wick is
                                      only a few pixels wide. */}
                                  <span
                                    className="pointer-events-none absolute bottom-0 h-[6px] w-[2px] bg-white/90"
                                    style={{
                                      left: `calc(${ts.realDurationFraction * 100}% - 2px)`,
                                    }}
                                  />
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <aside className="relative overflow-hidden rounded-2xl bg-terminal-surface p-4 shadow-layer-lg">
            <div className="pointer-events-none absolute -right-16 -top-16 h-36 w-36 rounded-full bg-terminal-blue/5 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-16 -left-16 h-36 w-36 rounded-full bg-terminal-green/5 blur-3xl" />
            <div className="relative">
              <div className="mb-3">
                <div className="text-sm font-sans font-semibold text-terminal-text">
                  Top Sessions
                </div>
                <div className="mt-0.5 text-[10px] font-mono text-terminal-dimmer">
                  Ranked by activity signals. Badges show provider and Cursor data source.
                </div>
              </div>
              <div className="space-y-2">
                {topSessions.map((ts) => {
                  const color = colorFor(ts.colorIdx);
                  return (
                    <button
                      type="button"
                      key={ts.session.sessionId}
                      onClick={() => navigateTo({ view: null, session: ts.session.slug })}
                      className="w-full rounded-xl bg-terminal-bg/45 p-2.5 text-left shadow-layer-sm transition-all duration-200 ease-material hover:bg-terminal-surface-hover hover:shadow-layer-md"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: color.solid }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-sans font-medium text-terminal-text">
                            {sessionTitle(ts.session)}
                          </div>
                          <div className="mt-0.5 truncate text-[10px] font-mono text-terminal-dimmer">
                            {projectName(ts.project)}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                            <span className="rounded-md bg-terminal-green-subtle px-1.5 py-0.5 text-terminal-green">
                              score {Math.round(ts.score)}
                            </span>
                            {sessionBadges(ts.session).map((badge) => (
                              <span
                                key={badge}
                                className="rounded-md bg-terminal-surface-2 px-1.5 py-0.5 text-terminal-dim"
                              >
                                {badge}
                              </span>
                            ))}
                            {ts.session.durationMs ? (
                              <span className="text-terminal-blue">
                                {fmtDuration(ts.session.durationMs)}
                              </span>
                            ) : null}
                            {ts.session.editCount > 0 ? (
                              <span className="text-terminal-dimmer">
                                {ts.session.editCount} {plural(ts.session.editCount, "edit")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed pointer-events-none w-80 rounded-xl border border-terminal-border bg-terminal-surface p-3 text-xs font-mono shadow-layer-xl"
          style={{
            // Keep the tooltip above hovered timeline bars.
            zIndex: 1000,
            left: Math.min(tooltip.x + 12, window.innerWidth - 336),
            top: Math.max(8, Math.min(tooltip.y - 8, window.innerHeight - 200)),
          }}
        >
          <div className="text-terminal-text font-medium mb-1.5 break-words leading-snug">
            {sessionTitle(tooltip.session)}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {sessionBadges(tooltip.session).map((badge) => (
              <span
                key={badge}
                className="rounded-md bg-terminal-surface-2 px-1.5 py-0.5 text-[10px] text-terminal-dim"
              >
                {badge}
              </span>
            ))}
          </div>
          <div className="text-terminal-dimmer space-y-0.5">
            {tooltip.session.startTime &&
              (() => {
                const startMs = new Date(tooltip.session.startTime).getTime();
                const endMs = activeEndMs(startMs, tooltip.session);
                const startISO = tooltip.session.startTime;
                const endISO = new Date(endMs).toISOString();
                const sameDay = fmtDate(startISO) === fmtDate(endISO);
                return (
                  <div>
                    {fmtDate(startISO)} {fmtShortTime(startISO)}
                    {endMs !== startMs && (
                      <span>
                        {" → "}
                        {sameDay ? "" : `${fmtDate(endISO)} `}
                        {fmtShortTime(endISO)}
                      </span>
                    )}
                  </div>
                );
              })()}
            {tooltip.session.durationMs && (
              <div className="text-terminal-blue">{fmtDuration(tooltip.session.durationMs)}</div>
            )}
            <div>
              {tooltip.session.promptCount}p · {tooltip.session.editCount}{" "}
              {plural(tooltip.session.editCount, "edit")} · {tooltip.session.toolCallCount}{" "}
              {plural(tooltip.session.toolCallCount, "tool")}
            </div>
            {tooltip.session.gitBranch && (
              <div className="text-terminal-purple">{tooltip.session.gitBranch}</div>
            )}
            {(tooltip.session.costEstimate ?? 0) > 0 && (
              <div className="text-terminal-orange">
                ${tooltip.session.costEstimate!.toFixed(3)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 2. File Hotspots View ───────────────────────────────────────────

interface FileCluster {
  file: string;
  displayName: string;
  totalEdits: number;
  sessions: Array<{ session: ScanResultSession; editCount: number; colorIdx: number }>;
}

interface ProjectFileGroup {
  project: string;
  colorIdx: number;
  files: FileCluster[];
  totalEdits: number;
  totalSessions: number;
}

function displayFileName(file: string, project: string): string {
  const normalizedProject = project.replace(/\/$/, "");
  if (normalizedProject && file.startsWith(`${normalizedProject}/`)) {
    return file.slice(normalizedProject.length + 1);
  }
  const parts = file.split("/");
  return parts.slice(-3).join("/");
}

function buildProjectFileGroups(groups: ProjectGroup[]): ProjectFileGroup[] {
  const projectFileGroups: ProjectFileGroup[] = [];

  for (const g of groups) {
    const fileMap = new Map<
      string,
      Array<{ session: ScanResultSession; editCount: number; colorIdx: number }>
    >();

    for (const s of g.sessions) {
      for (const f of s.filesModified) {
        const key = f.file;
        if (!fileMap.has(key)) fileMap.set(key, []);
        fileMap.get(key)!.push({ session: s, editCount: f.count, colorIdx: g.colorIdx });
      }
    }

    const files: FileCluster[] = [];
    for (const [file, sessions] of fileMap) {
      const uniqueSessions = [...new Map(sessions.map((s) => [s.session.sessionId, s])).values()];
      const totalEdits = uniqueSessions.reduce((sum, s) => sum + s.editCount, 0);
      if (uniqueSessions.length < 2 && totalEdits < 3) continue;
      files.push({
        file,
        displayName: displayFileName(file, g.project),
        sessions: uniqueSessions.sort((a, b) => b.editCount - a.editCount),
        totalEdits,
      });
    }

    if (files.length === 0) continue;
    files.sort((a, b) => b.totalEdits - a.totalEdits || b.sessions.length - a.sessions.length);
    projectFileGroups.push({
      project: g.project,
      colorIdx: g.colorIdx,
      files,
      totalEdits: files.reduce((sum, file) => sum + file.totalEdits, 0),
      totalSessions: files.reduce((sum, file) => sum + file.sessions.length, 0),
    });
  }

  return projectFileGroups.sort(
    (a, b) => b.totalEdits - a.totalEdits || b.totalSessions - a.totalSessions,
  );
}

function FileConnectionsView({ groups }: { groups: ProjectGroup[] }) {
  const projectFileGroups = useMemo(() => buildProjectFileGroups(groups), [groups]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (projectFileGroups.length === 0) {
      setSelectedProject(null);
      setSelectedFile(null);
      return;
    }
    if (!selectedProject || !projectFileGroups.some((g) => g.project === selectedProject)) {
      setSelectedProject(projectFileGroups[0].project);
      setSelectedFile(null);
    }
  }, [projectFileGroups, selectedProject]);

  if (projectFileGroups.length === 0) {
    return (
      <div className="p-8 text-center space-y-2">
        <div className="text-terminal-dimmer text-sm font-mono">No hot files found.</div>
        <div className="text-terminal-dimmer/60 text-xs font-mono">
          Cursor sessions without file edits are still shown in List and Timeline.
        </div>
      </div>
    );
  }

  const selectedProjectGroup =
    projectFileGroups.find((g) => g.project === selectedProject) ?? projectFileGroups[0];
  const selected = selectedFile
    ? selectedProjectGroup.files.find((c) => c.file === selectedFile)
    : null;

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-4 lg:flex-row">
      {/* Project list */}
      <div className="w-full shrink-0 space-y-2 overflow-y-auto lg:w-64">
        <div className="px-1">
          <div className="text-sm font-sans font-semibold text-terminal-text">Hot Files</div>
          <div className="mt-0.5 text-[10px] font-mono text-terminal-dimmer">
            {projectFileGroups.length} {plural(projectFileGroups.length, "project")} with hot files
          </div>
        </div>
        {projectFileGroups.map((group) => {
          const isSelected = selectedProjectGroup.project === group.project;
          return (
            <button
              key={group.project}
              onClick={() => {
                setSelectedProject(group.project);
                setSelectedFile(null);
              }}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ease-material ${
                isSelected
                  ? "border-transparent bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                  : "border-transparent bg-terminal-bg/35 text-terminal-text shadow-layer-sm hover:bg-terminal-surface-hover hover:shadow-layer-md"
              }`}
            >
              <div className="truncate text-xs font-sans font-semibold">
                {projectName(group.project)}
              </div>
              <div className="mt-0.5 truncate text-[10px] font-mono text-terminal-dimmer">
                {group.project}
              </div>
              <div className="mt-1 text-[10px] font-mono text-terminal-dimmer">
                {group.files.length} {plural(group.files.length, "file")} ·{" "}
                {group.totalEdits.toLocaleString()} {plural(group.totalEdits, "edit")}
              </div>
            </button>
          );
        })}
      </div>

      {/* Project files + detail panel */}
      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto">
        <div className="relative overflow-hidden rounded-2xl bg-terminal-bg/35 p-4 shadow-inner">
          <div className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-terminal-green/5 blur-2xl" />
          <div className="relative">
            <div className="text-sm font-sans font-semibold text-terminal-text">
              {projectName(selectedProjectGroup.project)}
            </div>
            <div className="mt-0.5 truncate text-xs font-mono text-terminal-dimmer">
              {selectedProjectGroup.project}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-mono text-terminal-dimmer">
              <span className="rounded-md bg-terminal-green-subtle px-1.5 py-0.5 text-terminal-green">
                {selectedProjectGroup.files.length}{" "}
                {plural(selectedProjectGroup.files.length, "hot file")}
              </span>
              <span>
                {selectedProjectGroup.totalEdits.toLocaleString()}{" "}
                {plural(selectedProjectGroup.totalEdits, "edit")}
              </span>
              <span>
                {selectedProjectGroup.totalSessions.toLocaleString()}{" "}
                {plural(selectedProjectGroup.totalSessions, "session")}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {selectedProjectGroup.files.map((cluster) => {
            const isSelected = selectedFile === cluster.file;
            return (
              <button
                key={cluster.file}
                onClick={() => setSelectedFile(isSelected ? null : cluster.file)}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition-all duration-200 ease-material ${
                  isSelected
                    ? "bg-terminal-green-subtle text-terminal-green shadow-layer-md"
                    : "bg-terminal-bg/40 text-terminal-text shadow-layer-sm hover:bg-terminal-surface-hover hover:shadow-layer-md"
                }`}
              >
                <div className="truncate text-xs font-mono">
                  {cluster.displayName.split("/").pop()}
                </div>
                <div className="mt-0.5 truncate text-[10px] font-mono text-terminal-dimmer">
                  {cluster.displayName}
                </div>
                <div className="mt-1 text-[10px] font-mono text-terminal-dimmer">
                  {cluster.totalEdits.toLocaleString()} {plural(cluster.totalEdits, "edit")} ·{" "}
                  {cluster.sessions.length} {plural(cluster.sessions.length, "session")}
                </div>
              </button>
            );
          })}
        </div>

        {selected ? (
          <div className="space-y-3">
            <div className="rounded-2xl bg-terminal-surface p-4 shadow-layer-sm">
              <div className="text-sm font-sans font-semibold text-terminal-text truncate">
                {selected.displayName.split("/").pop()}
              </div>
              <div className="text-xs font-mono text-terminal-dimmer mt-0.5 break-all">
                {selected.file}
              </div>
              <div className="text-xs font-mono text-terminal-dimmer mt-1">
                {selected.totalEdits.toLocaleString()} {plural(selected.totalEdits, "edit")} across{" "}
                {selected.sessions.length} {plural(selected.sessions.length, "session")}
              </div>
            </div>

            {/* Session list */}
            <div className="space-y-2">
              {selected.sessions.map((s) => {
                const color = colorFor(s.colorIdx);
                return (
                  <button
                    type="button"
                    key={s.session.sessionId}
                    onClick={() => navigateTo({ view: null, session: s.session.slug })}
                    className="flex w-full flex-col gap-2 rounded-xl bg-terminal-bg/45 p-3 text-left shadow-layer-sm transition-all duration-200 ease-material hover:bg-terminal-surface-hover hover:shadow-layer-md sm:flex-row sm:items-start sm:gap-3"
                  >
                    <div
                      className="hidden w-2 h-2 rounded-full mt-1.5 shrink-0 sm:block"
                      style={{ backgroundColor: color.solid }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-sans font-medium text-terminal-text truncate">
                        {sessionTitle(s.session)}
                      </div>
                      <div className="text-[9px] font-mono text-terminal-dimmer mt-0.5">
                        {projectName(s.session.project)} · {fmtDate(s.session.startTime)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-mono text-terminal-orange">
                      {s.editCount} {plural(s.editCount, "edit")}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-40 text-terminal-dimmer text-xs font-mono">
            Select a file in {projectName(selectedProjectGroup.project)} to see the sessions that
            modified it
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Container ──────────────────────────────────────────────────

export type ProjectRelationshipView = "timeline" | "files";

interface SessionRelationshipsViewProps {
  view: ProjectRelationshipView;
}

export default function SessionRelationshipsView({ view }: SessionRelationshipsViewProps) {
  const { sessions, loading, error } = useRelationshipData();

  // Collapse agent worktrees back to the project the user recognizes. The
  // session rows still expose the original path when it matters.
  const groups = useMemo(() => groupByProject(sessions, { collapseWorktrees: true }), [sessions]);
  const providerSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const label = providerBadgeLabel(s.provider);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => `${label} ${count}`)
      .join(" · ");
  }, [sessions]);
  const estimatedTimingCount = useMemo(
    () => sessions.filter((session) => sessionHasEstimatedTime(session)).length,
    [sessions],
  );

  if (loading) {
    return (
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-terminal-surface via-terminal-bg to-terminal-surface p-4 shadow-layer-xl">
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-terminal-green/5 blur-3xl" />
        <div className="relative space-y-4 animate-pulse">
          <div className="flex flex-wrap items-center gap-3">
            <div className="h-3 w-20 rounded bg-terminal-surface-2" />
            <div className="h-3 w-24 rounded bg-terminal-surface-2 opacity-70" />
            <div className="h-3 w-32 rounded bg-terminal-surface-2 opacity-50" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="rounded-2xl bg-terminal-bg/35 p-3 shadow-inner">
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="h-8 w-32 rounded bg-terminal-surface-2 opacity-60" />
                    <div className="h-9 flex-1 rounded-xl bg-terminal-surface/60 shadow-layer-sm" />
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl bg-terminal-surface p-4 shadow-layer-lg">
              <div className="mb-3 h-4 w-24 rounded bg-terminal-surface-2" />
              <div className="space-y-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="h-16 rounded-xl bg-terminal-bg/45 shadow-layer-sm" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-dimmer text-sm font-mono">Failed to load: {error}</div>
          <div className="text-terminal-dimmer/60 text-xs font-mono">
            Make sure the vibe-replay editor server is running.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-terminal-surface via-terminal-bg to-terminal-surface shadow-layer-xl">
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-terminal-green/5 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-56 w-56 rounded-full bg-terminal-blue/5 blur-3xl" />
      {/* Stats bar */}
      <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-[10px] font-mono text-terminal-dimmer md:px-6">
        <span>
          <span className="text-terminal-text">{sessions.length}</span>{" "}
          {plural(sessions.length, "session")}
        </span>
        <span>
          <span className="text-terminal-text">{groups.length}</span>{" "}
          {plural(groups.length, "project")}
        </span>
        {providerSummary && (
          <span>
            <span className="text-terminal-purple">{providerSummary}</span>
          </span>
        )}
        <span>
          <span className="text-terminal-blue">
            {fmtDuration(sessions.reduce((s, x) => s + (x.durationMs ?? 0), 0))}
          </span>{" "}
          total time
        </span>
        <span>
          <span className="text-terminal-orange">
            ${sessions.reduce((s, x) => s + (x.costEstimate ?? 0), 0).toFixed(2)}
          </span>{" "}
          total cost
        </span>
        <span>
          <span className="text-terminal-green">
            {sessions.reduce((s, x) => s + x.editCount, 0).toLocaleString()}
          </span>{" "}
          {plural(
            sessions.reduce((s, x) => s + x.editCount, 0),
            "edit",
          )}
        </span>
        {estimatedTimingCount > 0 && (
          <span>
            <span className="text-terminal-dimmer">{estimatedTimingCount}</span> estimated timing
          </span>
        )}
      </div>

      {/* View content */}
      <div className="relative z-10 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {view === "timeline" && <TimelineSwimlaneView groups={groups} />}
        {view === "files" && <FileConnectionsView groups={groups} />}
      </div>
    </div>
  );
}
