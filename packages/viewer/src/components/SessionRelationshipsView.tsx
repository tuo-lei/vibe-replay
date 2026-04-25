/**
 * SessionRelationshipsView — alternate Projects tab views:
 *   1. Timeline Swimlane — each project is a horizontal lane, sessions are time blocks
 *   2. File Hotspots     — project-scoped files sorted by repeated edits
 */

import { useEffect, useMemo, useState } from "react";
import { type ScanResultSession, useRelationshipData } from "../hooks/useRelationshipData";
import { shortName } from "../utils/format";
import { isAutomated, sessionScore } from "../utils/sessionSignals";
import { rollupProject } from "./dashboard-utils";

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

// Stable project color palette — maps project index to a color class
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
  { bg: "bg-pink-500/20", border: "border-pink-500", text: "text-pink-500", solid: "#ec4899" },
  { bg: "bg-cyan-500/20", border: "border-cyan-500", text: "text-cyan-500", solid: "#06b6d4" },
  {
    bg: "bg-yellow-500/20",
    border: "border-yellow-500",
    text: "text-yellow-500",
    solid: "#eab308",
  },
  { bg: "bg-red-500/20", border: "border-red-500", text: "text-red-500", solid: "#ef4444" },
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
    const sorted = [...sess].sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""));
    groups.push({
      project,
      sessions: sorted,
      totalDurationMs: sorted.reduce((s, x) => s + (x.durationMs ?? 0), 0),
      totalCost: sorted.reduce((s, x) => s + (x.costEstimate ?? 0), 0),
      lastActivity: sorted[0]?.endTime ?? sorted[0]?.startTime,
      colorIdx: idx++,
    });
  }
  return groups.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

// ─── 1. Timeline View ────────────────────────────────────────────────
//
// One row per project. Sessions within a project are lane-packed (no overlap),
// each at a uniform LANE_HEIGHT so labels are always readable. Importance is
// encoded in three independent visual channels:
//
//   minWidthPx  — important short sessions get widened so labels fit
//   fillIntensity — bg opacity (low score = ghosted outline, high score = solid)
//   accentBar  — top-decile sessions get a 3px solid left rim
//
// Automated / scheduled sessions are hidden by default and surfaced via a toggle.
// Per-project lane count is capped; overflow is rolled up into a "+N more" hint.

// Bars are *bottom-aligned* within their lane so the lane tops form a skyline
// — height encodes importance alongside width and fill. The 12x height ratio
// (8 → 96) makes top-tier sessions visibly tower over routine ones, and tall
// bars wrap their title onto multiple lines so the extra real-estate is useful.
//
// Per-lane height is *adaptive* — each lane sizes to its tallest bar (capped
// at MAX_BAR_HEIGHT_PX) instead of every lane reserving the global maximum,
// which previously left huge dead zones in lanes that only held short bars.
const LANE_GAP_PX = 4;
const MAX_LANES_PER_PROJECT = 5;
const MIN_BAR_HEIGHT_PX = 8; // floor — low-score sessions are short ticks
const MAX_BAR_HEIGHT_PX = 96; // cap — top-tier sessions tower at this height
const LABEL_VISIBLE_MIN_HEIGHT_PX = 14; // below this, render bar without label
// Line metrics for the dynamic line-clamp calculation. text-[10px] with
// leading-tight resolves to ~12px line-height; we reserve 6px of vertical
// padding inside the bar so a 14px bar still fits one line.
const LABEL_LINE_HEIGHT_PX = 12;
const LABEL_VERTICAL_PADDING_PX = 6;

const MIN_BAR_MIN_WIDTH_PX = 6; // floor for low-importance sessions
const MAX_BAR_MIN_WIDTH_PX = 160; // cap for the "important short session" widening
const TOP_ACCENT_SCORE_THRESHOLD = 60; // score >= this gets the left accent rim
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
  heightPx: number; // bar height (importance)
  fillAlpha: number; // 0-1 background alpha applied to color.solid
  showAccent: boolean;
  opacity: number;
  /**
   * Fraction of the rendered bar (0–1) that the *actual* session duration
   * occupies. When < 1, the bar was widened by the min-width-by-importance
   * floor; the remainder is visual padding. Drives the K-line "wick" strip
   * along the bottom that recovers true-duration intuition.
   */
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
  importance: number;
}

function fillAlphaFor(score: number): number {
  // low = ghost, mid = soft, high = solid
  if (score >= 60) return 0.45;
  if (score >= 30) return 0.28;
  return 0.12;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function opacityFor(score: number): number {
  // map score 0–100 → 0.55–1.0
  return 0.55 + Math.min(1, score / 100) * 0.45;
}

function minWidthFor(score: number): number {
  // sqrt curve so mid-importance sessions still get meaningful width
  const t = Math.sqrt(Math.max(0, Math.min(100, score)) / 100);
  return MIN_BAR_MIN_WIDTH_PX + t * (MAX_BAR_MIN_WIDTH_PX - MIN_BAR_MIN_WIDTH_PX);
}

function heightFor(score: number): number {
  // Linear (not sqrt) so importance maps proportionally to height — the whole
  // point of this channel is to make important sessions visibly larger.
  const t = Math.max(0, Math.min(100, score)) / 100;
  return MIN_BAR_HEIGHT_PX + t * (MAX_BAR_HEIGHT_PX - MIN_BAR_HEIGHT_PX);
}

/**
 * Lane packing biased to importance: highest-scoring sessions claim the top
 * lane first, so the most interesting work isn't pushed below the fold.
 *
 * Returns: per-session lane index, total lane count, and the number of sessions
 * that couldn't fit within MAX_LANES_PER_PROJECT (rolled up as "+N hidden").
 */
function packLanesByImportance(
  sessions: { startMs: number; endMs: number; score: number; original: ScanResultSession }[],
): { laneAssignments: Map<string, number>; laneCount: number; dropped: number } {
  const ordered = [...sessions].sort((a, b) => b.score - a.score);
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

  if (!isFinite(minMs) || !isFinite(maxMs) || maxMs <= minMs) {
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

    // Build interval list for lane packing. Crucially, the "interval" we hand
    // to the packer is the VISUAL extent (max of duration and min-width
    // converted back to time), not just the raw duration — otherwise widened
    // short sessions overlap their neighbours visually even though the packer
    // thought they were disjoint.
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

    const { laneAssignments, laneCount, dropped } = packLanesByImportance(intervals);

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
        showAccent: it.score >= TOP_ACCENT_SCORE_THRESHOLD,
        opacity: opacityFor(it.score),
        realDurationFraction,
      });
    }

    if (tSessions.length > 0) {
      // Render high-score sessions last so their accent rim sits on top of overlaps
      tSessions.sort((a, b) => a.score - b.score);

      // Per-lane heights: each lane sizes to its tallest bar (importance-biased
      // packing means lane 0 holds the highest scores and is naturally the
      // tallest). This avoids the dead vertical space when only the top lane
      // has tall bars and lower lanes hold short routine sessions.
      const laneHeightsPx: number[] = Array.from({ length: laneCount }, () => MIN_BAR_HEIGHT_PX);
      for (const ts of tSessions) {
        if (ts.heightPx > laneHeightsPx[ts.lane]) {
          laneHeightsPx[ts.lane] = ts.heightPx;
        }
      }
      const laneTopsPx: number[] = [];
      let cursor = 3;
      for (const h of laneHeightsPx) {
        laneTopsPx.push(cursor);
        cursor += h + LANE_GAP_PX;
      }
      const totalRowHeightPx = cursor + 3;

      projects.push({
        project: g.project,
        sessions: tSessions,
        laneCount,
        laneHeightsPx,
        laneTopsPx,
        totalRowHeightPx,
        hiddenInLanesCount: dropped,
        colorIdx: g.colorIdx,
        importance: tSessions.reduce((sum, t) => sum + t.score, 0),
      });
      totalSessions += tSessions.length;
    }
  }

  // Order project lanes by total importance (most active first)
  projects.sort((a, b) => b.importance - a.importance);

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

  const LABEL_WIDTH = 140;

  return (
    <div className="p-4 space-y-3 select-none">
      {/* Range selector + automated toggle */}
      <div className="flex flex-col gap-2 pl-1 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-[11px] font-mono text-terminal-dimmer flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {totalSessions} <span className="opacity-60">sessions</span>
          </span>
          <span className="opacity-50">·</span>
          <span className="opacity-70">
            row = project · height + width + fill = importance · time → x-axis
          </span>
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
          <div className="flex items-center gap-1">
            <span className="text-terminal-dimmer mr-1">Range:</span>
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                className={`px-2 py-1 rounded-md transition-colors ${
                  range === opt.value
                    ? "bg-terminal-green-subtle text-terminal-green"
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
          <div>No sessions in the last {RANGE_OPTIONS.find((o) => o.value === range)?.label}.</div>
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
        <div className="overflow-x-auto pb-2">
          <div className="min-w-[760px]">
            {/* Time axis header */}
            <div className="flex" style={{ paddingLeft: LABEL_WIDTH }}>
              <div className="relative flex-1 h-6 border-b border-terminal-border/40">
                {ticks.map((t, i) => (
                  <div
                    key={i}
                    className="absolute flex flex-col items-center"
                    style={{ left: `${t.leftPct}%`, transform: "translateX(-50%)" }}
                  >
                    <span className="text-[9px] font-mono text-terminal-dimmer whitespace-nowrap">
                      {t.label}
                    </span>
                    <div className="w-px h-1.5 bg-terminal-border/40 mt-0.5" />
                  </div>
                ))}
              </div>
            </div>

            {/* Project rows — lane-packed, bottom-aligned skyline.
              Per-bar HEIGHT, WIDTH (min-width by score), FILL alpha, and an
              optional left ACCENT RIM all encode importance — important sessions
              are visibly larger and more saturated, low-importance ones are
              short ghosted ticks but still labeled and clickable. */}
            {projects.map((p) => {
              const color = colorFor(p.colorIdx);
              const rowHeight = p.totalRowHeightPx;
              const accentColor = color.solid;
              return (
                <div
                  key={p.project}
                  className="flex items-stretch border-b border-terminal-border/20 group"
                >
                  {/* Project label */}
                  <div
                    className="flex flex-col justify-center shrink-0 py-1 pr-3 overflow-hidden"
                    style={{ width: LABEL_WIDTH, height: rowHeight }}
                  >
                    <div className={`text-xs font-sans font-medium truncate ${color.text}`}>
                      {shortName(p.project)}
                    </div>
                    <div className="text-[9px] font-mono text-terminal-dimmer truncate">
                      {p.sessions.length} session{p.sessions.length !== 1 ? "s" : ""}
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
                    className="relative flex-1 overflow-hidden bg-terminal-surface/20 group-hover:bg-terminal-surface/30 transition-colors"
                    style={{ height: rowHeight }}
                  >
                    {/* Grid lines */}
                    {ticks.map((t, i) => (
                      <div
                        key={i}
                        className="absolute top-0 bottom-0 w-px bg-terminal-border/10"
                        style={{ left: `${t.leftPct}%` }}
                      />
                    ))}

                    {/* Session blocks — variable height (importance), bottom-aligned within lane */}
                    {p.sessions.map((ts) => {
                      const automated = isAutomated(ts.session);
                      // Adaptive lanes: each lane's row height = its tallest bar.
                      // Bars are bottom-aligned within their lane.
                      const laneTop = p.laneTopsPx[ts.lane];
                      const laneH = p.laneHeightsPx[ts.lane];
                      const top = laneTop + (laneH - ts.heightPx);
                      const opacity = automated ? 0.4 : ts.opacity;
                      // Multi-line label support: clamp to whatever number of
                      // lines actually fits in the bar's height, so we use the
                      // full vertical real estate without growing the bar.
                      const lineClamp = Math.max(
                        1,
                        Math.floor(
                          (ts.heightPx - LABEL_VERTICAL_PADDING_PX) / LABEL_LINE_HEIGHT_PX,
                        ),
                      );
                      // K-line "wick": when the bar is widened by min-width, mark
                      // the actual session duration as a thin strip along the
                      // bottom so true duration is still readable.
                      const showWick = ts.realDurationFraction < 0.85;
                      return (
                        <div
                          key={ts.session.sessionId}
                          className={`absolute overflow-hidden rounded-sm cursor-pointer hover:brightness-125 hover:z-10 transition-all border ${color.border} border-opacity-50`}
                          style={{
                            left: `${ts.leftPct}%`,
                            width: `max(${ts.widthPct}%, ${ts.minWidthPx}px)`,
                            top,
                            height: ts.heightPx,
                            opacity,
                            zIndex: Math.round(ts.score),
                            backgroundColor: hexToRgba(accentColor, ts.fillAlpha),
                            ...(ts.showAccent
                              ? {
                                  boxShadow: `inset 3px 0 0 ${accentColor}`,
                                }
                              : {}),
                          }}
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
                            <div
                              className={`relative h-full flex text-[10px] font-mono leading-tight ${color.text} pointer-events-none ${
                                lineClamp === 1 ? "items-center" : "items-start pt-1"
                              }`}
                              style={{
                                paddingLeft: ts.showAccent ? 7 : 4,
                                paddingRight: 4,
                                minWidth: 0,
                              }}
                            >
                              <span
                                className={
                                  lineClamp === 1
                                    ? "block truncate min-w-0 flex-1"
                                    : "block min-w-0 flex-1 overflow-hidden"
                                }
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
                                {ts.session.title ?? ts.session.firstPrompt ?? ""}
                              </span>
                            </div>
                          )}
                          {showWick && (
                            <>
                              {/* K-line wick: bright strip along the bottom marks
                                the actual session duration within the widened
                                bar. Uses a near-white color so it contrasts
                                against the bar's saturated fill. */}
                              <div
                                className="absolute bottom-0 left-0 pointer-events-none"
                                style={{
                                  width: `${ts.realDurationFraction * 100}%`,
                                  height: 3,
                                  backgroundColor: "rgba(255, 255, 255, 0.85)",
                                }}
                                title="actual duration"
                              />
                              {/* End-of-real-time tick: a 2px-wide × 7px-tall mark
                                at the wick's right edge so the end-position
                                stays visible even when the wick itself is just
                                a few pixels wide. */}
                              <div
                                className="absolute bottom-0 pointer-events-none"
                                style={{
                                  left: `calc(${ts.realDurationFraction * 100}% - 2px)`,
                                  width: 2,
                                  height: 7,
                                  backgroundColor: "rgba(255, 255, 255, 0.95)",
                                }}
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed pointer-events-none bg-terminal-surface border border-terminal-border rounded-lg shadow-xl p-3 text-xs font-mono w-80"
          style={{
            // Bars use zIndex up to 100 (score-based), so the tooltip needs to
            // stay well above that — z-50 was actually below high-score bars.
            zIndex: 1000,
            left: Math.min(tooltip.x + 12, window.innerWidth - 336),
            top: Math.max(8, Math.min(tooltip.y - 8, window.innerHeight - 200)),
          }}
        >
          <div className="text-terminal-text font-medium mb-1.5 break-words leading-snug">
            {tooltip.session.title ?? tooltip.session.firstPrompt ?? tooltip.session.slug}
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
              {tooltip.session.promptCount}p · {tooltip.session.editCount} edits ·{" "}
              {tooltip.session.toolCallCount} tools
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
      if (uniqueSessions.length < 2) continue;
      files.push({
        file,
        displayName: displayFileName(file, g.project),
        sessions: uniqueSessions.sort((a, b) => b.editCount - a.editCount),
        totalEdits: uniqueSessions.reduce((sum, s) => sum + s.editCount, 0),
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
        <div className="text-terminal-dimmer text-sm font-mono">No shared files found.</div>
        <div className="text-terminal-dimmer/60 text-xs font-mono">
          Files edited by multiple sessions will appear here.
        </div>
      </div>
    );
  }

  const selectedProjectGroup =
    projectFileGroups.find((g) => g.project === selectedProject) ?? projectFileGroups[0];
  const selected = selectedFile
    ? selectedProjectGroup.files.find((c) => c.file === selectedFile)
    : null;
  const selectedProjectColor = colorFor(selectedProjectGroup.colorIdx);

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-4 lg:flex-row">
      {/* Project list */}
      <div className="w-full shrink-0 space-y-1 overflow-y-auto lg:w-64">
        <div className="text-[10px] font-mono text-terminal-dimmer mb-2 px-2">
          {projectFileGroups.length} projects with shared files
        </div>
        {projectFileGroups.map((group) => {
          const isSelected = selectedProjectGroup.project === group.project;
          const color = colorFor(group.colorIdx);
          return (
            <button
              key={group.project}
              onClick={() => {
                setSelectedProject(group.project);
                setSelectedFile(null);
              }}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors ${
                isSelected
                  ? `${color.bg} border ${color.border} ${color.text}`
                  : "hover:bg-terminal-surface-2 text-terminal-text border border-transparent"
              }`}
            >
              <div className="truncate font-semibold">{shortName(group.project)}</div>
              <div className="text-[9px] text-terminal-dimmer truncate">{group.project}</div>
              <div className="mt-1 text-[9px] text-terminal-dimmer">
                {group.files.length} files · {group.totalEdits.toLocaleString()} edits
              </div>
            </button>
          );
        })}
      </div>

      {/* Project files + detail panel */}
      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto">
        <div>
          <div className={`text-sm font-sans font-semibold ${selectedProjectColor.text}`}>
            {shortName(selectedProjectGroup.project)}
          </div>
          <div className="mt-0.5 truncate text-xs font-mono text-terminal-dimmer">
            {selectedProjectGroup.project}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {selectedProjectGroup.files.map((cluster) => {
            const isSelected = selectedFile === cluster.file;
            return (
              <button
                key={cluster.file}
                onClick={() => setSelectedFile(isSelected ? null : cluster.file)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors ${
                  isSelected
                    ? "bg-terminal-green/20 border border-terminal-green text-terminal-green"
                    : "hover:bg-terminal-surface-2 text-terminal-text border border-terminal-border/30"
                }`}
              >
                <div className="truncate">{cluster.displayName.split("/").pop()}</div>
                <div className="text-[9px] text-terminal-dimmer truncate">
                  {cluster.displayName}
                </div>
                <div className="mt-1 text-[9px] text-terminal-dimmer">
                  {cluster.totalEdits.toLocaleString()} edits · {cluster.sessions.length} sessions
                </div>
              </button>
            );
          })}
        </div>

        {selected ? (
          <div className="space-y-3">
            <div className="border-t border-terminal-border/30 pt-4">
              <div className="text-sm font-mono text-terminal-text font-medium truncate">
                {selected.displayName.split("/").pop()}
              </div>
              <div className="text-xs font-mono text-terminal-dimmer mt-0.5 break-all">
                {selected.file}
              </div>
              <div className="text-xs font-mono text-terminal-dimmer mt-1">
                {selected.totalEdits.toLocaleString()} edits across {selected.sessions.length}{" "}
                sessions
              </div>
            </div>

            {/* Session list */}
            <div className="space-y-2">
              {selected.sessions.map((s) => {
                const color = colorFor(s.colorIdx);
                return (
                  <div
                    key={s.session.sessionId}
                    className={`flex flex-col gap-2 p-3 rounded-lg border sm:flex-row sm:items-start sm:gap-3 ${color.bg} ${color.border}/40`}
                  >
                    <div
                      className="hidden w-2 h-2 rounded-full mt-1.5 shrink-0 sm:block"
                      style={{ backgroundColor: color.solid }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-mono ${color.text} truncate`}>
                        {s.session.title ?? s.session.firstPrompt ?? s.session.slug}
                      </div>
                      <div className="text-[9px] font-mono text-terminal-dimmer mt-0.5">
                        {shortName(s.session.project)} · {fmtDate(s.session.startTime)}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs font-mono text-terminal-orange">
                      {s.editCount} edit{s.editCount !== 1 ? "s" : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-40 text-terminal-dimmer text-xs font-mono">
            Select a file in {shortName(selectedProjectGroup.project)} to see the sessions that
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-terminal-dim text-sm font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
          Loading session data...
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
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-terminal-border/30 bg-terminal-surface/20">
      {/* Stats bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-terminal-border/20 px-4 py-2 text-[10px] font-mono text-terminal-dimmer md:px-6">
        <span>
          <span className="text-terminal-text">{sessions.length}</span> sessions
        </span>
        <span>
          <span className="text-terminal-text">{groups.length}</span> projects
        </span>
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
          edits
        </span>
      </div>

      {/* View content */}
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {view === "timeline" && <TimelineSwimlaneView groups={groups} />}
        {view === "files" && <FileConnectionsView groups={groups} />}
      </div>
    </div>
  );
}
