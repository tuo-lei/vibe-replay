/**
 * SessionRelationshipsView — alternate Projects tab views:
 *   1. Timeline Swimlane — each project is a horizontal lane, sessions are time blocks
 *   2. File Hotspots     — project-scoped files sorted by repeated edits
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { matchesProjectFacet } from "../engine/dashboard-filtering";
import { type ScanResultSession, useRelationshipData } from "../hooks/useRelationshipData";
import { plural } from "../utils/format";
import { isAutomated, sessionScore } from "../utils/sessionSignals";
import {
  cleanPrompt,
  formatDataSourceLabel,
  normalizeTitleText,
  projectDisplayName,
  projectName,
  providerBadgeLabel,
  rollupProject,
} from "./dashboard-utils";
import type { SessionLocation } from "@vibe-replay/types";

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
  badges.push(s.location?.kind === "ssh" ? s.location.label : "local");
  const source = s.dataSource ? formatDataSourceLabel(false, s.dataSource) : "";
  if (source) badges.push(source);
  if (sessionHasEstimatedTime(s)) badges.push("estimated time");
  return badges;
}

function sessionIdentityKey(
  session: Pick<ScanResultSession, "provider" | "sessionId" | "slug" | "location">,
): string {
  const locationKey = session.location?.kind === "ssh" ? session.location.id : "local";
  return `${locationKey}\0${session.provider}\0${session.sessionId || session.slug}`;
}

/**
 * Pop the Sessions tab's SessionDetailPopup for a session, regardless of
 * whether a replay has been generated yet. Dashboard listens for this event,
 * switches to the Sessions tab, and forwards the slug via URL so SessionsPanel
 * can open the popup uniformly for both "open replay" and "generate replay"
 * cases.
 */
function openSessionPopup(
  session: Pick<ScanResultSession, "slug" | "provider" | "sessionId" | "location">,
) {
  window.dispatchEvent(
    new CustomEvent("vibe-open-session", {
      detail: {
        slug: session.slug,
        provider: session.provider,
        sessionId: session.sessionId,
        location: session.location,
      },
    }),
  );
}

function rangeEmptyLabel(range: TimelineRange): string {
  switch (range) {
    case "1d":
      return "the last 24 hours";
    case "7d":
      return "the last 7 days";
    case "30d":
      return "the last 30 days";
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
  key: string;
  project: string;
  location?: ScanResultSession["location"];
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
    const project = options.collapseWorktrees
      ? rollupProject(s.project, s.projectIdentity)
      : s.project;
    const locationKey = s.location?.kind === "ssh" ? `ssh:${s.location.id}` : "local";
    const key = `${locationKey}\0${project}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }

  const groups: ProjectGroup[] = [];
  let idx = 0;
  for (const [key, sess] of map) {
    const project = options.collapseWorktrees
      ? rollupProject(sess[0]?.project || "", sess[0]?.projectIdentity)
      : sess[0]?.project || "";
    const sorted = [...sess].sort((a, b) => {
      const aStart = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bStart = b.startTime ? new Date(b.startTime).getTime() : 0;
      return bStart - aStart;
    });
    let totalDurationMs = 0;
    let totalCost = 0;
    let lastActivityMs = 0;
    for (const s of sorted) {
      totalDurationMs += s.durationMs ?? 0;
      totalCost += s.costEstimate ?? 0;
      if (s.startTime) {
        const startMs = new Date(s.startTime).getTime();
        const endMs = activeEndMs(startMs, s);
        if (endMs > lastActivityMs) lastActivityMs = endMs;
      }
    }
    groups.push({
      key,
      project,
      location: sorted[0]?.location,
      sessions: sorted,
      totalDurationMs,
      totalCost,
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
// Floor for a project row's height so the project label (name + count line)
// always has room. Without this, a project with one low-score session could
// produce a row only ~16px tall and clip the second label line's descenders.
const MIN_ROW_HEIGHT_PX = 40;
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
  /** Actual active interval within the rendered visual bar, 0–1. */
  actualStartFraction: number;
  actualEndFraction: number;
  /**
   * True when the bar would overflow the lane's right edge if rendered from
   * its leftPct. Right-anchored bars hug the right edge with their full
   * minWidth and grow leftward — the bar's left edge no longer aligns with
   * startTime, but the title stays readable. Tooltip carries the exact time.
   */
  rightAnchored: boolean;
}

interface TimelineProject {
  key: string;
  project: string;
  location?: ScanResultSession["location"];
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
  /** When true, drop the MAX_LANES_PER_PROJECT cap — used by per-project
      "show all" toggle so users can opt into seeing every session. */
  unlimited: boolean = false,
): { laneAssignments: Map<string, number>; laneCount: number; dropped: number } {
  const ordered = [...sessions].sort((a, b) => a.startMs - b.startMs || b.score - a.score);
  // Sessions are processed in start-time order, so each lane's only relevant
  // overlap candidate is the last interval placed in it — anything earlier
  // ended even sooner. Track only that single end timestamp per lane.
  const laneEnds: number[] = [];
  const laneAssignments = new Map<string, number>();
  let dropped = 0;
  const cap = unlimited ? Infinity : MAX_LANES_PER_PROJECT;

  for (const s of ordered) {
    let placed = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (s.startMs >= laneEnds[i]) {
        placed = i;
        break;
      }
    }

    if (placed === -1) {
      if (laneEnds.length >= cap) {
        dropped++;
        continue;
      }
      placed = laneEnds.length;
      laneEnds.push(s.endMs);
    } else {
      laneEnds[placed] = s.endMs;
    }

    laneAssignments.set(sessionIdentityKey(s.original), placed);
  }

  return { laneAssignments, laneCount: laneEnds.length, dropped };
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
  expandedProjects: Set<string> = new Set(),
): {
  projects: TimelineProject[];
  ticks: { leftPct: number; label: string }[];
  minMs: number;
  maxMs: number;
  totalSessions: number;
  hiddenAutomatedCount: number;
} {
  // Cache parsed start/end times per session — used at least 3 times each
  // (bounds, window filter, interval map). new Date(...).getTime() isn't free.
  const timed: Array<{
    session: ScanResultSession;
    startMs: number;
    endMs: number;
    group: ProjectGroup;
  }> = [];
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const g of groups) {
    for (const s of g.sessions) {
      if (!s.startTime) continue;
      const startMs = new Date(s.startTime).getTime();
      const endMs = activeEndMs(startMs, s);
      timed.push({ session: s, startMs, endMs, group: g });
      if (startMs < minMs) minMs = startMs;
      if (endMs > maxMs) maxMs = endMs;
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
  const minMsPerPx = rangeMs / APPROX_TIMELINE_WIDTH_PX;

  // Bucket per-project after window + automated filtering.
  const perGroup = new Map<ProjectGroup, typeof timed>();
  let hiddenAutomatedCount = 0;
  for (const entry of timed) {
    if (entry.endMs < rangeStart || entry.startMs > rangeEnd) continue;
    if (!includeAutomated && isAutomated(entry.session)) {
      hiddenAutomatedCount++;
      continue;
    }
    const bucket = perGroup.get(entry.group);
    if (bucket) bucket.push(entry);
    else perGroup.set(entry.group, [entry]);
  }

  const projects: TimelineProject[] = [];
  let totalSessions = 0;

  for (const g of groups) {
    const filtered = perGroup.get(g);
    if (!filtered || filtered.length === 0) continue;

    // Build packing intervals using the bar's *visual* extent (after right-
    // anchoring + min-width). Otherwise multiple late sessions all hugging the
    // right edge get placed into the same lane and overlap each other.
    const intervals = filtered.map(({ session: s, startMs, endMs: realEndMs }) => {
      const score = sessionScore(s);
      const minWidthMs = minWidthFor(score) * minMsPerPx;
      const naturalEndMs = Math.max(realEndMs, startMs + minWidthMs);
      const rightAnchored = naturalEndMs > rangeEnd;
      const visStartMs = rightAnchored ? Math.min(startMs, rangeEnd - minWidthMs) : startMs;
      const visEndMs = rightAnchored ? rangeEnd : naturalEndMs;
      return {
        startMs: visStartMs,
        endMs: visEndMs,
        realStartMs: startMs,
        realEndMs,
        score,
        original: s,
        rightAnchored,
      };
    });

    const { laneAssignments, laneCount, dropped } = packTimelineLanes(
      intervals,
      expandedProjects.has(g.key),
    );

    const tSessions: TimelineSession[] = [];
    for (const it of intervals) {
      const lane = laneAssignments.get(sessionIdentityKey(it.original));
      if (lane == null) continue; // dropped due to lane cap
      // Clip to viewport on the left so a bar starting before the window
      // begins at 0% (no mid-string truncation).
      const rawLeftPct = ((it.realStartMs - rangeStart) / rangeMs) * 100;
      const rawRightPct = ((it.realEndMs - rangeStart) / rangeMs) * 100;
      const leftPct = Math.max(0, rawLeftPct);
      const widthPct = Math.max(0, rawRightPct - leftPct);
      const minWidthPx = minWidthFor(it.score);
      const visualStartMs = Math.max(it.startMs, rangeStart);
      const visualEndMs = Math.min(it.endMs, rangeEnd);
      const visualDurationMs = Math.max(1, visualEndMs - visualStartMs);
      const actualStartFraction = Math.max(
        0,
        Math.min(1, (Math.max(it.realStartMs, visualStartMs) - visualStartMs) / visualDurationMs),
      );
      const actualEndFraction = Math.max(
        actualStartFraction,
        Math.min(1, (Math.min(it.realEndMs, visualEndMs) - visualStartMs) / visualDurationMs),
      );
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
        actualStartFraction,
        actualEndFraction,
        rightAnchored: it.rightAnchored,
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
      const contentHeight = cursor + 4;
      const totalRowHeightPx = Math.max(contentHeight, MIN_ROW_HEIGHT_PX);
      // If row was floored above content height, push lane tops down so bars
      // stay bottom-aligned within the now-taller row.
      const verticalPadding = totalRowHeightPx - contentHeight;
      if (verticalPadding > 0) {
        for (let i = 0; i < laneTopsPx.length; i++) laneTopsPx[i] += verticalPadding;
      }

      projects.push({
        key: g.key,
        project: g.project,
        location: g.location,
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

type TimelineRange = "1d" | "7d" | "30d";

const RANGE_OPTIONS: { value: TimelineRange; label: string; days: number }[] = [
  { value: "1d", label: "1D", days: 1 },
  { value: "7d", label: "7D", days: 7 },
  { value: "30d", label: "30D", days: 30 },
];

function rangeWindow(range: TimelineRange): { start?: number; end?: number } {
  const opt = RANGE_OPTIONS.find((o) => o.value === range);
  if (!opt) return {};
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
  // Per-project lane-cap override: clicking "+N hidden" on a project's label
  // adds it here, which lifts MAX_LANES_PER_PROJECT for that project.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const toggleExpanded = (project: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };
  const { start, end } = useMemo(() => rangeWindow(range), [range]);
  const { projects, ticks, totalSessions, hiddenAutomatedCount } = useMemo(
    () => buildTimeline(groups, start, end, showAutomated, expandedProjects),
    [groups, start, end, showAutomated, expandedProjects],
  );
  const estimatedTimingCount = useMemo(() => {
    let count = 0;
    for (const p of projects) {
      for (const ts of p.sessions) {
        if (sessionHasEstimatedTime(ts.session)) count++;
      }
    }
    return count;
  }, [projects]);

  const LABEL_WIDTH = 140;

  return (
    <div className="space-y-4 p-4 select-none">
      {/* Range selector + automated toggle */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-terminal-green shadow-[0_0_8px_rgba(34,197,94,0.55)]" />
            <div className="text-sm font-sans font-semibold text-terminal-text">Work Timeline</div>
          </div>
          <div className="text-xs font-mono text-terminal-dimmer">
            {totalSessions} {plural(totalSessions, "session")} · rows are projects · bar position
            and width show active time
            {estimatedTimingCount > 0 ? ` · ${estimatedTimingCount} estimated` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[10px] font-mono text-terminal-dimmer">
            <span>Hover for details</span>
            <span className="text-terminal-border">·</span>
            <span>Click a session to inspect it</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] font-mono">
          {hiddenAutomatedCount > 0 && !showAutomated && (
            <button
              onClick={() => setShowAutomated(true)}
              className="rounded-lg bg-terminal-orange-subtle px-2.5 py-1 text-terminal-orange transition-colors hover:bg-terminal-orange-emphasis"
              title="Scheduled / automated sessions are hidden by default"
            >
              + {hiddenAutomatedCount} automated hidden ▸
            </button>
          )}
          {showAutomated && (
            <button
              onClick={() => setShowAutomated(false)}
              className="rounded-lg bg-terminal-purple-subtle px-2.5 py-1 text-terminal-purple transition-colors hover:bg-terminal-purple-emphasis"
            >
              hide automated
            </button>
          )}
          <div className="inline-flex items-center rounded-xl bg-terminal-surface p-0.5 shadow-layer-sm">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                aria-pressed={range === opt.value}
                title={`Show ${opt.label} timeline`}
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
          {range !== "30d" && (
            <button
              onClick={() => setRange("30d")}
              className="text-terminal-green hover:underline text-xs"
            >
              Show 30 days →
            </button>
          )}
        </div>
      ) : (
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
                  <div
                    key={p.key}
                    className="group flex items-stretch overflow-hidden rounded-xl border transition-colors"
                    style={{
                      borderColor: hexToRgba(accentColor, 0.2),
                      backgroundColor: hexToRgba(accentColor, 0.025),
                    }}
                  >
                    {/* Project label */}
                    <div
                      className="flex shrink-0 flex-col justify-center overflow-hidden py-1 pr-3"
                      style={{
                        width: LABEL_WIDTH,
                        height: rowHeight,
                        backgroundColor: hexToRgba(accentColor, 0.055),
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accentColor }}
                        />
                        <div
                          className={`min-w-0 text-xs font-sans font-medium truncate ${color.text}`}
                        >
                          {projectDisplayName(p.project, p.sessions[0]?.session.projectIdentity)}
                        </div>
                      </div>
                      <div className="text-[9px] font-mono text-terminal-dimmer truncate">
                        {p.sessions.length} {plural(p.sessions.length, "session")}
                        {p.location?.kind === "ssh" && ` · ${p.location.label}`}
                        {p.hiddenInLanesCount > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(p.key)}
                            className="ml-1 text-terminal-orange hover:underline cursor-pointer"
                            title={`Show the ${p.hiddenInLanesCount} session(s) hidden by the lane cap`}
                          >
                            · +{p.hiddenInLanesCount} hidden ▸
                          </button>
                        )}
                        {expandedProjects.has(p.key) && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(p.key)}
                            className="ml-1 text-terminal-purple hover:underline cursor-pointer"
                            title="Restore the lane cap"
                          >
                            · collapse
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Lane area */}
                    <div
                      className="relative flex-1 overflow-hidden rounded-r-xl shadow-inner"
                      style={{
                        height: rowHeight,
                        backgroundColor: hexToRgba(accentColor, 0.035),
                      }}
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
                        return (
                          <button
                            type="button"
                            key={sessionIdentityKey(ts.session)}
                            className="absolute overflow-hidden rounded-md text-left shadow-layer-sm transition-all duration-200 ease-material hover:z-10 hover:shadow-layer-md"
                            style={{
                              ...(ts.rightAnchored
                                ? // Hug the right edge with full minWidth so the
                                  // title stays readable for sessions starting
                                  // close to "now"; the bar grows leftward.
                                  { right: 0, width: `${ts.minWidthPx}px` }
                                : {
                                    left: `${ts.leftPct}%`,
                                    width: `max(${ts.widthPct}%, ${ts.minWidthPx}px)`,
                                  }),
                              top,
                              height: ts.heightPx,
                              opacity,
                              zIndex: automated ? 1 : 2,
                              backgroundColor: hexToRgba(accentColor, ts.fillAlpha),
                            }}
                            aria-label={`Open ${sessionTitle(ts.session)}`}
                            onClick={() => openSessionPopup(ts.session)}
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
                                className={`relative z-[1] pointer-events-none block min-w-0 px-1.5 text-[10px] font-mono leading-tight ${color.text} ${
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
                            {/* Every bar gets the same duration rail. The muted
                                track is the visual bar; the bright segment marks
                                the actual active interval, including right-anchored
                                sessions and bars widened for readable hit targets. */}
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[3px] bg-white/20">
                              <span
                                className="absolute bottom-0 h-full min-w-[2px] rounded-full bg-white/85"
                                style={{
                                  left: `${ts.actualStartFraction * 100}%`,
                                  right: `${(1 - ts.actualEndFraction) * 100}%`,
                                }}
                                title="actual duration"
                              />
                            </span>
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
      )}

      {/* Portal the fixed tooltip out of the scrollable timeline pane. A fixed
          child can still expand an ancestor's scrollable overflow, which makes
          the pane jump when hover state toggles. */}
      {tooltip &&
        typeof document !== "undefined" &&
        createPortal(
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
          </div>,
          document.body,
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
  key: string;
  project: string;
  location?: ScanResultSession["location"];
  projectIdentity?: ScanResultSession["projectIdentity"];
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
      const uniqueSessions = [
        ...new Map(sessions.map((s) => [sessionIdentityKey(s.session), s])).values(),
      ];
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
      key: g.key,
      project: g.project,
      location: g.location,
      projectIdentity: g.sessions[0]?.projectIdentity,
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

function FileConnectionsView({
  groups,
  hideProjectList,
}: {
  groups: ProjectGroup[];
  /** True when the outer Projects sidebar already restricts us to one project. */
  hideProjectList?: boolean;
}) {
  const projectFileGroups = useMemo(() => buildProjectFileGroups(groups), [groups]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (projectFileGroups.length === 0) {
      setSelectedProject(null);
      setSelectedFile(null);
      return;
    }
    if (!selectedProject || !projectFileGroups.some((g) => g.key === selectedProject)) {
      setSelectedProject(projectFileGroups[0].key);
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
    projectFileGroups.find((g) => g.key === selectedProject) ?? projectFileGroups[0];
  const selected = selectedFile
    ? selectedProjectGroup.files.find((c) => c.file === selectedFile)
    : null;

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-4 lg:flex-row">
      {/* Project list — hidden when the outer Projects sidebar already filters
          us to a single project (avoids a redundant second-level project list) */}
      {!hideProjectList && (
        <div className="w-full shrink-0 space-y-2 overflow-y-auto lg:w-64">
          <div className="px-1">
            <div className="text-sm font-sans font-semibold text-terminal-text">Hot Files</div>
            <div className="mt-0.5 text-[10px] font-mono text-terminal-dimmer">
              {projectFileGroups.length} {plural(projectFileGroups.length, "project")} with hot
              files
            </div>
          </div>
          {projectFileGroups.map((group) => {
            const isSelected = selectedProjectGroup.key === group.key;
            return (
              <button
                key={group.key}
                onClick={() => {
                  setSelectedProject(group.key);
                  setSelectedFile(null);
                }}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-200 ease-material ${
                  isSelected
                    ? "border-transparent bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                    : "border-transparent bg-terminal-bg/35 text-terminal-text shadow-layer-sm hover:bg-terminal-surface-hover hover:shadow-layer-md"
                }`}
              >
                <div className="truncate text-xs font-sans font-semibold">
                  {projectDisplayName(group.project, group.projectIdentity)}
                </div>
                {group.location?.kind === "ssh" && (
                  <div className="mt-0.5 truncate text-[10px] font-mono text-terminal-purple">
                    {group.location.label}
                  </div>
                )}
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
      )}

      {/* Project files + detail panel — files grid on the left scrolls
          independently; the detail panel is sticky on the right so clicking a
          file shows its sessions immediately, no scrolling required. */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="relative overflow-hidden rounded-2xl bg-terminal-bg/35 p-4 shadow-inner">
          <div className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-terminal-green/5 blur-2xl" />
          <div className="relative">
            <div className="text-sm font-sans font-semibold text-terminal-text">
              {projectDisplayName(
                selectedProjectGroup.project,
                selectedProjectGroup.projectIdentity,
              )}
            </div>
            {selectedProjectGroup.location?.kind === "ssh" && (
              <div className="mt-0.5 text-[10px] font-mono text-terminal-purple">
                {selectedProjectGroup.location.label}
              </div>
            )}
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

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* Files grid — left column, scrolls independently */}
          <div className="min-w-0 grid grid-cols-1 gap-2 xl:grid-cols-2 self-start">
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

          {/* Detail panel — right column, sticky so it stays visible while
              the user scrolls the files grid */}
          <div className="lg:sticky lg:top-3 lg:self-start lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
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
                    {selected.totalEdits.toLocaleString()} {plural(selected.totalEdits, "edit")}{" "}
                    across {selected.sessions.length} {plural(selected.sessions.length, "session")}
                  </div>
                </div>

                {/* Session list */}
                <div className="space-y-2">
                  {selected.sessions.map((s) => {
                    const color = colorFor(s.colorIdx);
                    return (
                      <button
                        type="button"
                        key={sessionIdentityKey(s.session)}
                        onClick={() => openSessionPopup(s.session)}
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
              <div className="flex h-40 items-center justify-center rounded-2xl bg-terminal-bg/35 text-terminal-dimmer text-xs font-mono p-4 text-center">
                Select a file to see the sessions that modified it
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Container ──────────────────────────────────────────────────

export type ProjectRelationshipView = "timeline" | "files";

interface SessionRelationshipsViewProps {
  view: ProjectRelationshipView;
  /**
   * If set, restrict the view to a single project (post-rollup key).
   * The outer Projects sidebar already shows the project list, so the inner
   * Hot Files project list collapses to a single row when filter is active.
   */
  projectFilter?: string;
  projectLocation?: SessionLocation | "local";
}

export default function SessionRelationshipsView({
  view,
  projectFilter,
  projectLocation,
}: SessionRelationshipsViewProps) {
  const { sessions, loading, error } = useRelationshipData();

  // Collapse agent worktrees back to the project the user recognizes. The
  // session rows still expose the original path when it matters.
  const filteredSessions = useMemo(
    () =>
      projectFilter
        ? sessions.filter((s) =>
            matchesProjectFacet(s, projectFilter, "__all__", rollupProject, projectLocation),
          )
        : sessions,
    [sessions, projectFilter, projectLocation],
  );
  const groups = useMemo(
    () => groupByProject(filteredSessions, { collapseWorktrees: true }),
    [filteredSessions],
  );
  const providerSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of filteredSessions) {
      const label = providerBadgeLabel(s.provider);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => `${label} ${count}`)
      .join(" · ");
  }, [filteredSessions]);
  const estimatedTimingCount = useMemo(
    () => filteredSessions.filter((session) => sessionHasEstimatedTime(session)).length,
    [filteredSessions],
  );
  const totals = useMemo(() => {
    let durationMs = 0;
    let cost = 0;
    let edits = 0;
    for (const s of filteredSessions) {
      durationMs += s.durationMs ?? 0;
      cost += s.costEstimate ?? 0;
      edits += s.editCount;
    }
    return { durationMs, cost, edits };
  }, [filteredSessions]);

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
      {/* Stats bar — hidden when projectFilter is set, because the parent
          ProjectOverview already shows the project's all-time rollup. Showing
          a window-filtered count beneath an all-time card was a UX trap (same
          project, two visibly different "N sessions" numbers). */}
      {!projectFilter && (
        <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-[10px] font-mono text-terminal-dimmer md:px-6">
          <span>
            <span className="text-terminal-text">{filteredSessions.length}</span>{" "}
            {plural(filteredSessions.length, "session")}
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
            <span className="text-terminal-blue">{fmtDuration(totals.durationMs)}</span> total time
          </span>
          <span>
            <span className="text-terminal-orange">${totals.cost.toFixed(2)}</span> total cost
          </span>
          <span>
            <span className="text-terminal-green">{totals.edits.toLocaleString()}</span>{" "}
            {plural(totals.edits, "edit")}
          </span>
          {estimatedTimingCount > 0 && (
            <span>
              <span className="text-terminal-dimmer">{estimatedTimingCount}</span> estimated timing
            </span>
          )}
        </div>
      )}

      {/* View content */}
      <div className="relative z-10 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {view === "timeline" && <TimelineSwimlaneView groups={groups} />}
        {view === "files" && (
          <FileConnectionsView groups={groups} hideProjectList={Boolean(projectFilter)} />
        )}
      </div>
    </div>
  );
}
