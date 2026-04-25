/**
 * SessionRelationshipsView — Four relationship visualizations for the Projects tab:
 *   1. Project Grouping  — collapsible project rows with session lists
 *   2. Timeline Swimlane — each project is a horizontal lane, sessions are time blocks
 *   3. Dispatch Tree     — parent→child agent relationships
 *   4. File Connections  — sessions linked by shared modified files
 */

import { useMemo, useState } from "react";
import { type ScanResultSession, useRelationshipData } from "../hooks/useRelationshipData";
import { shortName, timeAgo } from "../utils/format";

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

function groupByProject(sessions: ScanResultSession[]): ProjectGroup[] {
  const map = new Map<string, ScanResultSession[]>();
  for (const s of sessions) {
    if (!map.has(s.project)) map.set(s.project, []);
    map.get(s.project)!.push(s);
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

// ─── 1. Project Grouping View ────────────────────────────────────────

function SessionRow({
  session,
  color,
}: {
  session: ScanResultSession;
  color: (typeof PROJECT_COLORS)[0];
}) {
  const duration = session.durationMs ?? 0;
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-terminal-border/30 hover:bg-terminal-surface-2/50 text-xs font-mono">
      <div className="flex-1 min-w-0">
        <div className="text-terminal-text truncate">
          {session.title ?? session.firstPrompt ?? session.slug}
        </div>
        <div className="text-terminal-dimmer text-[10px] mt-0.5">
          {fmtDate(session.startTime)} {fmtShortTime(session.startTime)}
          {session.endTime && <span className="ml-2">{timeAgo(session.endTime)} ago</span>}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {duration > 0 && <span className={color.text}>{fmtDuration(duration)}</span>}
        <span className="text-terminal-dimmer">{session.promptCount}p</span>
        {session.editCount > 0 && (
          <span className="text-terminal-orange">{session.editCount} edits</span>
        )}
        {(session.costEstimate ?? 0) > 0 && (
          <span className="text-terminal-dimmer">${session.costEstimate!.toFixed(2)}</span>
        )}
        {session.gitBranch && (
          <span className="text-terminal-purple truncate max-w-[80px]">{session.gitBranch}</span>
        )}
      </div>
    </div>
  );
}

function ProjectGroupRow({ group }: { group: ProjectGroup }) {
  const [expanded, setExpanded] = useState(false);
  const color = colorFor(group.colorIdx);

  return (
    <div className={`rounded-xl overflow-hidden border border-terminal-border/40 ${color.bg}`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-terminal-surface-hover/30 transition-colors"
        onClick={() => setExpanded((x) => !x)}
      >
        <span className={`text-xs ${expanded ? "rotate-90" : ""} transition-transform shrink-0`}>
          ▶
        </span>
        <div
          className={`w-1.5 h-1.5 rounded-full shrink-0`}
          style={{ backgroundColor: color.solid }}
        />
        <div className="flex-1 min-w-0">
          <span className={`font-sans font-semibold text-sm ${color.text}`}>
            {shortName(group.project)}
          </span>
          <span className="text-[10px] font-mono text-terminal-dimmer ml-2 truncate">
            {group.project}
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0 text-xs font-mono">
          <span className="text-terminal-text">
            {group.sessions.length} <span className="text-terminal-dimmer">sessions</span>
          </span>
          {group.totalDurationMs > 0 && (
            <span className="text-terminal-blue">{fmtDuration(group.totalDurationMs)}</span>
          )}
          {group.totalCost > 0 && (
            <span className="text-terminal-orange">${group.totalCost.toFixed(2)}</span>
          )}
          {group.lastActivity && (
            <span className="text-terminal-dimmer">{timeAgo(group.lastActivity)}</span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-terminal-border/30 bg-terminal-surface/60">
          {group.sessions.map((s) => (
            <SessionRow key={s.sessionId} session={s} color={color} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectGroupingView({ groups }: { groups: ProjectGroup[] }) {
  return (
    <div className="space-y-2 p-4">
      {groups.map((g) => (
        <ProjectGroupRow key={g.project} group={g} />
      ))}
    </div>
  );
}

// ─── 2. Timeline Swimlane View ───────────────────────────────────────

interface Lane {
  start: number;
  end: number;
}

/** Simple lane packing: return the lane index for a session */
function assignLane(lanes: Lane[], startMs: number, endMs: number): number {
  for (let i = 0; i < lanes.length; i++) {
    if (startMs >= lanes[i].end) {
      lanes[i] = { start: startMs, end: endMs };
      return i;
    }
  }
  lanes.push({ start: startMs, end: endMs });
  return lanes.length - 1;
}

const LANE_HEIGHT_PX = 20;
const LANE_GAP_PX = 2;

interface TimelineSession {
  session: ScanResultSession;
  leftPct: number;
  widthPct: number;
  lane: number;
}

interface TimelineProject {
  project: string;
  sessions: TimelineSession[];
  laneCount: number;
  colorIdx: number;
}

function buildTimeline(groups: ProjectGroup[]): {
  projects: TimelineProject[];
  ticks: { leftPct: number; label: string }[];
  minMs: number;
  maxMs: number;
} {
  // Determine time bounds from sessions with valid times
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const g of groups) {
    for (const s of g.sessions) {
      if (s.startTime) minMs = Math.min(minMs, new Date(s.startTime).getTime());
      const end = s.endTime
        ? new Date(s.endTime).getTime()
        : s.startTime
          ? new Date(s.startTime).getTime() + (s.durationMs ?? 0)
          : null;
      if (end) maxMs = Math.max(maxMs, end);
    }
  }

  if (!isFinite(minMs) || !isFinite(maxMs) || maxMs <= minMs) {
    return { projects: [], ticks: [], minMs: 0, maxMs: 0 };
  }

  const totalMs = maxMs - minMs;
  const paddingMs = totalMs * 0.01;
  const rangeStart = minMs - paddingMs;
  const rangeEnd = maxMs + paddingMs;
  const rangeMs = rangeEnd - rangeStart;

  const projects: TimelineProject[] = [];

  for (const g of groups) {
    const lanes: Lane[] = [];
    const tSessions: TimelineSession[] = [];

    // Sort by start time for lane packing
    const sorted = [...g.sessions]
      .filter((s) => s.startTime)
      .sort((a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime());

    for (const s of sorted) {
      const startMs = new Date(s.startTime!).getTime();
      const endMs = s.endTime ? new Date(s.endTime).getTime() : startMs + (s.durationMs ?? 60000);
      const leftPct = ((startMs - rangeStart) / rangeMs) * 100;
      const widthPct = Math.max(((endMs - startMs) / rangeMs) * 100, 0.3);
      const lane = assignLane(lanes, startMs, endMs);
      tSessions.push({ session: s, leftPct, widthPct, lane });
    }

    if (tSessions.length > 0) {
      projects.push({
        project: g.project,
        sessions: tSessions,
        laneCount: tSessions.reduce((max, s) => Math.max(max, s.lane), 0) + 1,
        colorIdx: g.colorIdx,
      });
    }
  }

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

  return { projects, ticks, minMs, maxMs };
}

interface TooltipInfo {
  session: ScanResultSession;
  x: number;
  y: number;
}

function TimelineSwimlaneView({ groups }: { groups: ProjectGroup[] }) {
  const { projects, ticks } = useMemo(() => buildTimeline(groups), [groups]);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-terminal-dimmer text-sm font-mono">
        No sessions with timing data available.
      </div>
    );
  }

  const LABEL_WIDTH = 140;

  return (
    <div className="p-4 space-y-0 select-none">
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

      {/* Swimlanes */}
      {projects.map((p) => {
        const color = colorFor(p.colorIdx);
        const rowHeight = p.laneCount * (LANE_HEIGHT_PX + LANE_GAP_PX) + 8;
        return (
          <div
            key={p.project}
            className="flex items-stretch border-b border-terminal-border/20 group"
          >
            {/* Project label */}
            <div
              className="flex flex-col justify-center shrink-0 py-1 pr-3"
              style={{ width: LABEL_WIDTH }}
            >
              <div className={`text-xs font-sans font-medium truncate ${color.text}`}>
                {shortName(p.project)}
              </div>
              <div className="text-[9px] font-mono text-terminal-dimmer">
                {p.sessions.length} sessions
              </div>
            </div>

            {/* Lane area */}
            <div
              className="relative flex-1 bg-terminal-surface/20 group-hover:bg-terminal-surface/30 transition-colors"
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

              {/* Session blocks */}
              {p.sessions.map((ts) => {
                const top = 4 + ts.lane * (LANE_HEIGHT_PX + LANE_GAP_PX);
                return (
                  <div
                    key={ts.session.sessionId}
                    className={`absolute rounded cursor-pointer hover:brightness-110 transition-all ${color.bg} border ${color.border} border-opacity-60`}
                    style={{
                      left: `${ts.leftPct}%`,
                      width: `max(${ts.widthPct}%, 4px)`,
                      top,
                      height: LANE_HEIGHT_PX,
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
                    {ts.widthPct > 3 && (
                      <span
                        className={`absolute inset-0 flex items-center px-1 text-[8px] font-mono ${color.text} truncate opacity-80`}
                      >
                        {ts.session.title ?? ts.session.firstPrompt ?? ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-terminal-surface border border-terminal-border rounded-lg shadow-xl p-3 text-xs font-mono max-w-xs"
          style={{
            left: Math.min(tooltip.x + 12, window.innerWidth - 280),
            top: Math.max(8, Math.min(tooltip.y - 8, window.innerHeight - 160)),
          }}
        >
          <div className="text-terminal-text font-medium mb-1 truncate">
            {tooltip.session.title ?? tooltip.session.firstPrompt ?? tooltip.session.slug}
          </div>
          <div className="text-terminal-dimmer space-y-0.5">
            {tooltip.session.startTime && (
              <div>
                {fmtDate(tooltip.session.startTime)} {fmtShortTime(tooltip.session.startTime)}
                {tooltip.session.endTime && <span> → {fmtShortTime(tooltip.session.endTime)}</span>}
              </div>
            )}
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

// ─── 3. Dispatch Tree View ───────────────────────────────────────────

interface DispatchNode {
  session: ScanResultSession;
  children: DispatchNode[];
  depth: number;
}

// Grace window for the heuristic: a child session may continue a few minutes
// past the parent's recorded endTime due to async shutdown / clock skew between
// parent and sub-agent JSONL writes. Wide enough to catch real children, small
// enough to avoid pulling in unrelated later sessions.
const DISPATCH_END_GRACE_MS = 5 * 60 * 1000;

function buildDispatchTree(sessions: ScanResultSession[]): DispatchNode[] {
  // Claude Code sub-agent detection: sessions with subAgentCount > 0 are parents.
  // Without explicit parent-child IDs in the scan results, we infer relationships
  // heuristically: sessions that started within a parent session's time range
  // and have the same project are likely children.
  const withSubAgents = sessions.filter((s) => s.subAgentCount > 0 && s.startTime);
  const candidates = sessions.filter((s) => s.subAgentCount === 0 && s.startTime);

  const roots: DispatchNode[] = [];
  const usedIds = new Set<string>();

  for (const parent of withSubAgents) {
    const parentStart = new Date(parent.startTime!).getTime();
    const parentEnd = parent.endTime
      ? new Date(parent.endTime).getTime()
      : parentStart + (parent.durationMs ?? 0);

    // Find sessions that ran entirely within this parent's window
    const children: DispatchNode[] = [];
    for (const child of candidates) {
      if (usedIds.has(child.sessionId)) continue;
      if (child.project !== parent.project) continue;
      const childStart = new Date(child.startTime!).getTime();
      const childEnd = child.endTime
        ? new Date(child.endTime).getTime()
        : childStart + (child.durationMs ?? 0);
      if (childStart >= parentStart && childEnd <= parentEnd + DISPATCH_END_GRACE_MS) {
        children.push({ session: child, children: [], depth: 1 });
        usedIds.add(child.sessionId);
      }
    }

    if (children.length > 0) {
      roots.push({ session: parent, children, depth: 0 });
      usedIds.add(parent.sessionId);
    }
  }

  // Sessions with subAgentCount > 0 but no children found — show as isolated
  for (const s of withSubAgents) {
    if (!usedIds.has(s.sessionId)) {
      roots.push({ session: s, children: [], depth: 0 });
    }
  }

  return roots;
}

function DispatchNodeRow({ node, colorIdx }: { node: DispatchNode; colorIdx: number }) {
  const [expanded, setExpanded] = useState(true);
  const color = colorFor(colorIdx);
  const s = node.session;

  return (
    <div>
      <div
        className={`flex items-start gap-2 py-2 px-3 rounded-lg ${node.depth === 0 ? `${color.bg} border ${color.border}/40` : "hover:bg-terminal-surface-2/30"}`}
        style={{ marginLeft: node.depth * 32 }}
      >
        {node.children.length > 0 && (
          <button
            className="shrink-0 mt-0.5 text-terminal-dimmer hover:text-terminal-text"
            onClick={() => setExpanded((x) => !x)}
          >
            <span
              className={`text-[10px] ${expanded ? "rotate-90" : ""} inline-block transition-transform`}
            >
              ▶
            </span>
          </button>
        )}
        {node.children.length === 0 && (
          <span className="w-4 shrink-0 text-terminal-dimmer text-[10px]">
            {node.depth > 0 ? "└" : "·"}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-mono ${node.depth === 0 ? color.text : "text-terminal-text"} truncate`}
            >
              {s.title ?? s.firstPrompt ?? s.slug}
            </span>
            {node.depth === 0 && s.subAgentCount > 0 && (
              <span className="text-[9px] font-mono text-terminal-purple bg-terminal-purple/10 px-1.5 py-0.5 rounded">
                {s.subAgentCount} subagents
              </span>
            )}
          </div>
          <div className="text-[9px] font-mono text-terminal-dimmer mt-0.5 flex gap-2">
            {s.startTime && <span>{fmtDate(s.startTime)}</span>}
            {s.durationMs && (
              <span className="text-terminal-blue">{fmtDuration(s.durationMs)}</span>
            )}
            <span>
              {s.promptCount}p · {s.editCount} edits
            </span>
          </div>
        </div>
      </div>
      {expanded &&
        node.children.map((child) => (
          <DispatchNodeRow key={child.session.sessionId} node={child} colorIdx={colorIdx} />
        ))}
    </div>
  );
}

function DispatchTreeView({ groups }: { groups: ProjectGroup[] }) {
  const trees = useMemo(() => {
    const allSessions = groups.flatMap((g) => g.sessions);
    return buildDispatchTree(allSessions);
  }, [groups]);

  if (trees.length === 0) {
    return (
      <div className="p-8 text-center space-y-2">
        <div className="text-terminal-dimmer text-sm font-mono">
          No dispatch relationships found.
        </div>
        <div className="text-terminal-dimmer/60 text-xs font-mono">
          Sessions with sub-agents will appear here as parent→child trees.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="text-xs font-mono text-terminal-dimmer mb-4">
        {trees.length} dispatch group{trees.length !== 1 ? "s" : ""} found
        {" · "}
        {trees.reduce((s, t) => s + t.children.length, 0)} child sessions
      </div>
      {trees.map((node, i) => {
        const colorIdx = groups.findIndex((g) => g.project === node.session.project);
        return (
          <div key={node.session.sessionId} className="space-y-1">
            <DispatchNodeRow node={node} colorIdx={colorIdx >= 0 ? colorIdx : i} />
          </div>
        );
      })}
    </div>
  );
}

// ─── 4. File Connections View ────────────────────────────────────────

interface FileCluster {
  file: string;
  displayName: string;
  sessions: Array<{ session: ScanResultSession; editCount: number; colorIdx: number }>;
}

function buildFileClusters(groups: ProjectGroup[]): FileCluster[] {
  const fileMap = new Map<
    string,
    Array<{ session: ScanResultSession; editCount: number; colorIdx: number }>
  >();

  for (const g of groups) {
    for (const s of g.sessions) {
      for (const f of s.filesModified) {
        // Use full path as key to avoid false connections across projects
        const key = f.file;
        if (!fileMap.has(key)) fileMap.set(key, []);
        fileMap.get(key)!.push({ session: s, editCount: f.count, colorIdx: g.colorIdx });
      }
    }
  }

  // Only show files touched by 2+ sessions
  const clusters: FileCluster[] = [];
  for (const [file, sessions] of fileMap) {
    const uniqueSessions = [...new Map(sessions.map((s) => [s.session.sessionId, s])).values()];
    if (uniqueSessions.length >= 2) {
      // Shortened display: last 3 path segments
      const parts = file.split("/");
      const displayName = parts.slice(-3).join("/");
      clusters.push({ file, displayName, sessions: uniqueSessions });
    }
  }

  return clusters.sort((a, b) => b.sessions.length - a.sessions.length).slice(0, 50);
}

function FileConnectionsView({ groups }: { groups: ProjectGroup[] }) {
  const clusters = useMemo(() => buildFileClusters(groups), [groups]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  if (clusters.length === 0) {
    return (
      <div className="p-8 text-center space-y-2">
        <div className="text-terminal-dimmer text-sm font-mono">No shared files found.</div>
        <div className="text-terminal-dimmer/60 text-xs font-mono">
          Files edited by multiple sessions will appear here.
        </div>
      </div>
    );
  }

  const selected = selectedFile ? clusters.find((c) => c.file === selectedFile) : null;

  return (
    <div className="flex gap-4 p-4 h-full">
      {/* File list */}
      <div className="w-64 shrink-0 space-y-1 overflow-y-auto">
        <div className="text-[10px] font-mono text-terminal-dimmer mb-2 px-2">
          {clusters.length} shared files
        </div>
        {clusters.map((cluster) => {
          const isSelected = selectedFile === cluster.file;
          const maxEdits = cluster.sessions.reduce((max, s) => Math.max(max, s.editCount), 0);
          return (
            <button
              key={cluster.file}
              onClick={() => setSelectedFile(isSelected ? null : cluster.file)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors ${
                isSelected
                  ? "bg-terminal-green/20 border border-terminal-green text-terminal-green"
                  : "hover:bg-terminal-surface-2 text-terminal-text border border-transparent"
              }`}
            >
              <div className="truncate">{cluster.displayName.split("/").pop()}</div>
              <div className="text-[9px] text-terminal-dimmer truncate">{cluster.displayName}</div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex gap-0.5">
                  {cluster.sessions.slice(0, 8).map((s, i) => (
                    <div
                      key={i}
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor: colorFor(s.colorIdx).solid,
                        opacity: 0.4 + (s.editCount / maxEdits) * 0.6,
                      }}
                    />
                  ))}
                </div>
                <span className="text-[9px] text-terminal-dimmer">
                  {cluster.sessions.length} sessions
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-mono text-terminal-text font-medium">
                {selected.displayName.split("/").pop()}
              </div>
              <div className="text-xs font-mono text-terminal-dimmer mt-0.5">{selected.file}</div>
              <div className="text-xs font-mono text-terminal-dimmer mt-1">
                {selected.sessions.length} sessions modified this file
              </div>
            </div>

            {/* Session list */}
            <div className="space-y-2">
              {selected.sessions.map((s) => {
                const color = colorFor(s.colorIdx);
                return (
                  <div
                    key={s.session.sessionId}
                    className={`flex items-start gap-3 p-3 rounded-lg border ${color.bg} ${color.border}/40`}
                  >
                    <div
                      className="w-2 h-2 rounded-full mt-1.5 shrink-0"
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
            Select a file to see which sessions modified it
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Container ──────────────────────────────────────────────────

type RelView = "timeline" | "group" | "tree" | "files";

const VIEW_TABS: { id: RelView; label: string; icon: string; desc: string }[] = [
  { id: "timeline", label: "Timeline", icon: "⟶", desc: "Sessions as time blocks per project" },
  { id: "group", label: "Groups", icon: "≡", desc: "Sessions grouped by project" },
  { id: "tree", label: "Dispatch", icon: "⤷", desc: "Parent → child agent relationships" },
  { id: "files", label: "Files", icon: "⊕", desc: "Sessions linked by shared files" },
];

interface SessionRelationshipsViewProps {
  onBack?: () => void;
}

export default function SessionRelationshipsView({ onBack }: SessionRelationshipsViewProps) {
  const { sessions, loading, error } = useRelationshipData();
  const [activeView, setActiveView] = useState<RelView>("timeline");

  const groups = useMemo(() => groupByProject(sessions), [sessions]);

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
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 md:px-6 py-3 border-b border-terminal-border/40 shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="text-terminal-dimmer hover:text-terminal-text text-xs font-mono transition-colors"
          >
            ← Projects
          </button>
        )}
        <div className="flex-1">
          <h2 className="text-sm font-sans font-semibold text-terminal-text">
            Session Relationships
            <span className="ml-2 text-terminal-dimmer font-normal text-xs font-mono">
              {sessions.length} sessions · {groups.length} projects
            </span>
          </h2>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-1">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveView(tab.id)}
              title={tab.desc}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono transition-all ${
                activeView === tab.id
                  ? "bg-terminal-green/15 text-terminal-green border border-terminal-green/30"
                  : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-2"
              }`}
            >
              <span className="text-[11px]">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 px-4 md:px-6 py-2 border-b border-terminal-border/20 text-[10px] font-mono text-terminal-dimmer shrink-0">
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
      <div className="flex-1 overflow-y-auto">
        {activeView === "timeline" && <TimelineSwimlaneView groups={groups} />}
        {activeView === "group" && <ProjectGroupingView groups={groups} />}
        {activeView === "tree" && <DispatchTreeView groups={groups} />}
        {activeView === "files" && <FileConnectionsView groups={groups} />}
      </div>
    </div>
  );
}
