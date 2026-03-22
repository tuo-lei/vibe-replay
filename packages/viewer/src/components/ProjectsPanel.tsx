/**
 * ProjectsPanel — Full-page Projects tab showing all projects from scan insights.
 */

import { useMemo, useState } from "react";
import { navigateTo } from "./dashboard-utils";
import { useScanInsightsContext } from "./InsightsPanel";
import { formatDuration } from "./StatsPanel";

interface ProjectsPanelProps {
  onNavigate: (view: "home" | "sessions" | "replays" | "projects") => void;
}

// ─── Activity sparkline (compact) ───────────────────────────────────

function MiniSparkline({ sessionsPerDay }: { sessionsPerDay: Record<string, number> }) {
  const data = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const result: number[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      result.push(sessionsPerDay[key] || 0);
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [sessionsPerDay]);

  const max = Math.max(...data, 1);

  return (
    <div className="flex items-end gap-px h-4">
      {data.map((count, i) => (
        <div
          key={i}
          className={`w-1 rounded-sm ${count > 0 ? "bg-terminal-green" : "bg-terminal-surface-2"}`}
          style={{
            height: count > 0 ? `${Math.max(20, (count / max) * 100)}%` : "2px",
            opacity: count > 0 ? 0.4 + (count / max) * 0.6 : 0.2,
          }}
        />
      ))}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function ProjectsPanel({ onNavigate }: ProjectsPanelProps) {
  const { userInsights, scanStatus } = useScanInsightsContext();
  const [sortBy, setSortBy] = useState<"lastActivity" | "sessions" | "cost" | "duration">(
    "lastActivity",
  );

  const projects = useMemo(() => {
    if (!userInsights) return [];
    const sorted = [...userInsights.topProjects];
    switch (sortBy) {
      case "lastActivity":
        sorted.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
        break;
      case "sessions":
        sorted.sort((a, b) => b.sessions - a.sessions);
        break;
      case "cost":
        sorted.sort((a, b) => b.cost - a.cost);
        break;
      case "duration":
        sorted.sort((a, b) => b.durationMs - a.durationMs);
        break;
    }
    return sorted;
  }, [userInsights, sortBy]);

  const isScanning = scanStatus?.running && scanStatus.total > 0;

  if (!userInsights && !isScanning) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2 text-terminal-dimmer text-sm font-mono">
          <p>No scan data available yet.</p>
          <p className="text-xs">Projects will appear once the background scan completes.</p>
        </div>
      </div>
    );
  }

  if (!userInsights && isScanning) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-terminal-dim text-sm font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-purple animate-pulse" />
          Analyzing sessions... {scanStatus!.scanned}/{scanStatus!.total}
        </div>
      </div>
    );
  }

  const handleProjectClick = (project: string) => {
    onNavigate("sessions");
    setTimeout(() => {
      navigateTo({ tab: "sessions", project });
    }, 50);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-sans font-semibold text-terminal-text">
              All Projects
              <span className="ml-2 text-terminal-dimmer font-normal">({projects.length})</span>
            </h2>
          </div>
          <div className="flex items-center gap-1 text-[10px] font-sans">
            <span className="text-terminal-dimmer mr-1">Sort:</span>
            {(
              [
                ["lastActivity", "Recent"],
                ["sessions", "Sessions"],
                ["cost", "Cost"],
                ["duration", "Duration"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-2 py-1 rounded-md transition-colors ${
                  sortBy === key
                    ? "bg-terminal-green-subtle text-terminal-green"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {isScanning && (
          <div className="flex items-center gap-2 px-1">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-purple animate-pulse" />
            <span className="text-xs font-mono text-terminal-dim">
              Analyzing... {scanStatus!.scanned}/{scanStatus!.total}
            </span>
          </div>
        )}

        {/* Projects grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {projects.map((p) => {
            const name = p.project.split("/").pop() || p.project;
            return (
              <button
                key={p.project}
                onClick={() => handleProjectClick(p.project)}
                className="text-left bg-terminal-surface rounded-xl p-4 shadow-layer-sm hover:bg-terminal-surface-hover transition-all duration-200 group border-l-2 border-terminal-green/40 hover:border-terminal-green"
              >
                {/* Project name + last activity */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className="text-sm font-sans font-medium text-terminal-text truncate group-hover:text-terminal-green transition-colors">
                      {name}
                    </div>
                    <div className="text-[10px] font-mono text-terminal-dimmer truncate mt-0.5">
                      {p.project}
                    </div>
                  </div>
                  {p.lastActivity && (
                    <span className="text-[10px] font-mono text-terminal-dimmer shrink-0">
                      {timeAgo(p.lastActivity)}
                    </span>
                  )}
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-3 text-xs font-mono flex-wrap mb-3">
                  <span className="text-terminal-text tabular-nums">
                    {p.sessions}{" "}
                    <span className="text-terminal-dimmer">
                      session{p.sessions !== 1 ? "s" : ""}
                    </span>
                  </span>
                  {p.durationMs > 0 && (
                    <span className="text-terminal-blue tabular-nums">
                      {formatDuration(p.durationMs)}
                    </span>
                  )}
                  {p.cost > 0 && (
                    <span className="text-terminal-orange tabular-nums">${p.cost.toFixed(2)}</span>
                  )}
                  <span className="text-terminal-green tabular-nums">
                    {fmtNum(p.prompts)} <span className="text-terminal-dimmer">prompts</span>
                  </span>
                </div>

                {/* Secondary stats */}
                <div className="flex items-center gap-3 text-[10px] font-mono text-terminal-dimmer flex-wrap mb-2">
                  {p.toolCalls > 0 && <span>{fmtNum(p.toolCalls)} tools</span>}
                  {p.edits > 0 && <span>{fmtNum(p.edits)} edits</span>}
                  {p.branchCount > 0 && (
                    <span>
                      {p.branchCount} branch{p.branchCount !== 1 ? "es" : ""}
                    </span>
                  )}
                  {p.prCount > 0 && (
                    <span>
                      {p.prCount} PR{p.prCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {p.memoryFileCount > 0 && (
                    <span>
                      {p.memoryFileCount} memory file{p.memoryFileCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>

                {/* Sparkline */}
                <MiniSparkline sessionsPerDay={p.sessionsPerDay} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
