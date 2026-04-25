/**
 * ProjectsPanel — Full-page Projects tab showing all projects from scan insights.
 */

import { useMemo, useState } from "react";
import { localDayKey } from "../utils/date";
import { timeAgo } from "../utils/format";
import { navigateTo, projectName, rollupTopProjects } from "./dashboard-utils";
import { useScanInsightsContext } from "./InsightsPanel";
import SessionRelationshipsView from "./SessionRelationshipsView";
import { formatDuration } from "./StatsPanel";

interface ProjectsPanelProps {
  onNavigate: (view: "home" | "sessions" | "replays" | "projects") => void;
}

type PanelMode = "list" | "timeline" | "files";

const PROJECT_VIEW_TABS: { id: PanelMode; label: string }[] = [
  { id: "list", label: "List" },
  { id: "timeline", label: "Timeline" },
  { id: "files", label: "Hot Files" },
];

// ─── Activity sparkline (compact) ───────────────────────────────────

function MiniSparkline({ sessionsPerDay }: { sessionsPerDay: Record<string, number> }) {
  const data = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const result: number[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = localDayKey(cursor)!;
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function ProjectsPanel({ onNavigate }: ProjectsPanelProps) {
  const { userInsights, scanStatus } = useScanInsightsContext();
  const [mode, setMode] = useState<PanelMode>("list");

  const projects = useMemo(() => {
    if (!userInsights) return [];
    // Roll Claude agent worktrees up under their parent so the grid isn't
    // drowned by single-session sandbox dirs.
    const sorted = rollupTopProjects(userInsights.topProjects);
    sorted.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
    return sorted;
  }, [userInsights]);

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
    <div className="relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-terminal-green-subtle via-transparent to-transparent opacity-70" />
        <div className="absolute inset-0 bg-dot-grid opacity-40" />
      </div>
      <div className="relative max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-sans font-semibold text-terminal-text">
              All Projects
              <span className="ml-2 text-terminal-dimmer font-normal">({projects.length})</span>
            </h2>
            <p className="mt-1 text-xs font-mono text-terminal-dimmer">
              Recent work, timelines, and hotspots across your AI sessions.
            </p>
          </div>
          <div className="inline-flex w-fit items-center rounded-xl bg-terminal-surface/80 p-0.5 shadow-layer-sm backdrop-blur-sm">
            {PROJECT_VIEW_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMode(tab.id)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-sans font-semibold transition-all duration-200 ease-material ${
                  mode === tab.id
                    ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {tab.label}
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

        {mode === "timeline" && <SessionRelationshipsView view="timeline" />}
        {mode === "files" && <SessionRelationshipsView view="files" />}

        {/* Projects grid */}
        {mode === "list" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projects.map((p) => {
              const name = projectName(p.project);
              return (
                <button
                  key={p.project}
                  onClick={() => handleProjectClick(p.project)}
                  className="hover-lift group relative overflow-hidden rounded-xl bg-gradient-to-br from-terminal-surface via-terminal-surface to-terminal-bg/70 p-4 text-left shadow-layer-sm transition-all duration-200 ease-material hover:bg-terminal-surface-hover"
                >
                  <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-gradient-to-b from-terminal-green to-terminal-blue opacity-50 transition-opacity group-hover:opacity-100" />
                  <span className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-terminal-green/5 blur-2xl opacity-0 transition-opacity group-hover:opacity-100" />
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
                        {timeAgo(p.lastActivity, "long")}
                      </span>
                    )}
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-3 text-xs font-mono flex-wrap mb-3">
                    <span className="text-terminal-text tabular-nums">
                      {p.sessions}{" "}
                      <span className="text-terminal-dimmer">{plural(p.sessions, "session")}</span>
                    </span>
                    {p.durationMs > 0 && (
                      <span className="text-terminal-blue tabular-nums">
                        {formatDuration(p.durationMs)}
                      </span>
                    )}
                    {p.cost > 0 && (
                      <span className="text-terminal-orange tabular-nums">
                        ${p.cost.toFixed(2)}
                      </span>
                    )}
                    <span className="text-terminal-green tabular-nums">
                      {fmtNum(p.prompts)}{" "}
                      <span className="text-terminal-dimmer">{plural(p.prompts, "prompt")}</span>
                    </span>
                  </div>

                  {/* Secondary stats */}
                  <div className="flex items-center gap-3 text-[10px] font-mono text-terminal-dimmer flex-wrap mb-2">
                    {p.toolCalls > 0 && (
                      <span>
                        {fmtNum(p.toolCalls)} {plural(p.toolCalls, "tool")}
                      </span>
                    )}
                    {p.edits > 0 && (
                      <span>
                        {fmtNum(p.edits)} {plural(p.edits, "edit")}
                      </span>
                    )}
                    {p.branchCount > 0 && (
                      <span>
                        {p.branchCount} {plural(p.branchCount, "branch", "branches")}
                      </span>
                    )}
                    {p.prCount > 0 && (
                      <span>
                        {p.prCount} {plural(p.prCount, "PR")}
                      </span>
                    )}
                    {p.memoryFileCount > 0 && (
                      <span>
                        {p.memoryFileCount} Claude {p.memoryFileCount !== 1 ? "memories" : "memory"}
                      </span>
                    )}
                  </div>

                  {/* Sparkline */}
                  <MiniSparkline sessionsPerDay={p.sessionsPerDay} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
