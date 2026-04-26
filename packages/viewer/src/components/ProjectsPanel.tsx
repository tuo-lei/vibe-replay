/**
 * ProjectsPanel — full-page Projects tab.
 *
 * Layout mirrors Sessions / Replays: a left sidebar listing projects, and a
 * right pane showing the selected project's content. View tabs (Overview /
 * Timeline / Hot Files) live in the right pane and adapt to whether one
 * project is selected or "All projects".
 */

import { useMemo, useState } from "react";
import { ALL_PROJECTS } from "../hooks/usePanelFilters";
import { localDayKey } from "../utils/date";
import { plural, timeAgo } from "../utils/format";
import type { Tab } from "./Dashboard";
import { navigateTo, projectName, rollupTopProjects } from "./dashboard-utils";
import { useScanInsightsContext } from "./InsightsPanel";
import SessionRelationshipsView from "./SessionRelationshipsView";
import { fmtNum, formatDuration } from "./StatsPanel";

interface ProjectsPanelProps {
  onNavigate: (view: Tab) => void;
}

type PanelMode = "overview" | "timeline" | "files";

const PROJECT_VIEW_TABS: { id: PanelMode; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "files", label: "Hot Files" },
];

// ─── Activity sparkline (compact) ───────────────────────────────────

function MiniSparkline({
  sessionsPerDay,
  size = "sm",
}: {
  sessionsPerDay: Record<string, number>;
  size?: "sm" | "md";
}) {
  const { data, max } = useMemo(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const result: number[] = [];
    let m = 1;
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = localDayKey(cursor)!;
      const count = sessionsPerDay[key] || 0;
      result.push(count);
      if (count > m) m = count;
      cursor.setDate(cursor.getDate() + 1);
    }
    return { data: result, max: m };
  }, [sessionsPerDay]);

  const heightClass = size === "md" ? "h-8" : "h-4";

  return (
    <div className={`flex items-end gap-px ${heightClass}`}>
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

// ─── Project sidebar (left pane) ────────────────────────────────────

interface SidebarProject {
  project: string;
  sessions: number;
  lastActivity?: string;
}

function ProjectSidebar({
  projects,
  selected,
  onSelect,
}: {
  projects: SidebarProject[];
  selected: string;
  onSelect: (project: string) => void;
}) {
  const totalSessions = projects.reduce((sum, p) => sum + p.sessions, 0);
  return (
    <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
      <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
        <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
          Projects
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {/* All projects */}
        <button
          onClick={() => onSelect(ALL_PROJECTS)}
          className={`w-full text-left px-3 py-2.5 text-xs font-sans rounded-lg transition-all duration-200 ease-material flex items-center justify-between ${
            selected === ALL_PROJECTS
              ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
              : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
          }`}
        >
          <span className="font-medium">All projects</span>
          <span
            className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
              selected === ALL_PROJECTS
                ? "bg-terminal-green-emphasis text-terminal-green"
                : "bg-terminal-surface text-terminal-dimmer"
            }`}
          >
            {totalSessions}
          </span>
        </button>

        <div className="h-px bg-terminal-border-subtle mx-2 my-1.5" />

        {/* Per-project items */}
        {projects.map((p) => {
          const isActive = selected === p.project;
          const label = projectName(p.project);
          return (
            <button
              key={p.project}
              onClick={() => onSelect(p.project)}
              title={p.project}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 ease-material group ${
                isActive ? "bg-terminal-green-subtle shadow-layer-sm" : "hover:bg-terminal-surface"
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <span
                  className={`text-xs font-sans truncate ${
                    isActive ? "text-terminal-green font-medium" : "text-terminal-text"
                  }`}
                >
                  {label}
                </span>
                <span
                  className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs shrink-0 ${
                    isActive
                      ? "bg-terminal-green-emphasis text-terminal-green"
                      : "bg-terminal-surface text-terminal-dimmer"
                  }`}
                >
                  {p.sessions}
                </span>
              </div>
              {p.lastActivity && (
                <div
                  className={`mt-1 ml-0.5 text-xs font-mono truncate ${isActive ? "text-terminal-dim" : "text-terminal-dimmer"}`}
                >
                  {timeAgo(p.lastActivity, "long")}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Project Overview (single-project right pane content) ───────────

type ProjectInsight = ReturnType<typeof rollupTopProjects>[number];

function ProjectOverview({
  project,
  insight,
  onOpenSessions,
}: {
  project: string;
  insight: ProjectInsight;
  onOpenSessions: () => void;
}) {
  const name = projectName(project);
  return (
    <div className="hover-lift relative overflow-hidden rounded-2xl bg-gradient-to-br from-terminal-surface via-terminal-surface to-terminal-bg/70 p-5 shadow-layer-md">
      <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-gradient-to-b from-terminal-green to-terminal-blue opacity-60" />
      <span className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-terminal-green/5 blur-2xl" />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-sans font-semibold text-terminal-text truncate">
            {name}
          </div>
          <div className="text-[10px] font-mono text-terminal-dimmer truncate mt-0.5">
            {project}
          </div>
        </div>
        {insight.lastActivity && (
          <span className="text-[10px] font-mono text-terminal-dimmer shrink-0">
            {timeAgo(insight.lastActivity, "long")}
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
        <Stat
          label={plural(insight.sessions, "session")}
          value={insight.sessions.toString()}
          tone="text"
        />
        {insight.durationMs > 0 && (
          <Stat label="active time" value={formatDuration(insight.durationMs)} tone="blue" />
        )}
        {insight.cost > 0 && (
          <Stat label="cost" value={`$${insight.cost.toFixed(2)}`} tone="orange" />
        )}
        <Stat
          label={plural(insight.prompts, "prompt")}
          value={fmtNum(insight.prompts)}
          tone="green"
        />
      </div>

      {/* Secondary stats */}
      <div className="mt-3 flex items-center gap-3 text-[10px] font-mono text-terminal-dimmer flex-wrap">
        {insight.toolCalls > 0 && (
          <span>
            {fmtNum(insight.toolCalls)} {plural(insight.toolCalls, "tool")}
          </span>
        )}
        {insight.edits > 0 && (
          <span>
            {fmtNum(insight.edits)} {plural(insight.edits, "edit")}
          </span>
        )}
        {insight.branchCount > 0 && (
          <span>
            {insight.branchCount} {plural(insight.branchCount, "branch", "branches")}
          </span>
        )}
        {insight.prCount > 0 && (
          <span>
            {insight.prCount} {plural(insight.prCount, "PR")}
          </span>
        )}
        {insight.memoryFileCount > 0 && (
          <span>
            {insight.memoryFileCount}{" "}
            {insight.memoryFileCount === 1 ? "Claude memory" : "Claude memories"}
          </span>
        )}
      </div>

      {/* Sparkline */}
      <div className="mt-4">
        <MiniSparkline sessionsPerDay={insight.sessionsPerDay} size="md" />
        <div className="mt-1 text-[10px] font-mono text-terminal-dimmer">last 30 days</div>
      </div>

      <button
        onClick={onOpenSessions}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-terminal-green-subtle px-3 py-1.5 text-xs font-sans font-semibold text-terminal-green hover:bg-terminal-green-emphasis transition-colors"
      >
        Open sessions →
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "text" | "blue" | "orange" | "green";
}) {
  const toneClass = {
    text: "text-terminal-text",
    blue: "text-terminal-blue",
    orange: "text-terminal-orange",
    green: "text-terminal-green",
  }[tone];
  return (
    <div className="rounded-lg bg-terminal-bg/40 p-2.5">
      <div className={`text-sm font-sans font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-mono text-terminal-dimmer">{label}</div>
    </div>
  );
}

// ─── All-projects grid (right pane content when "All projects" selected) ─

function ProjectsGrid({
  projects,
  onProjectClick,
}: {
  projects: ProjectInsight[];
  onProjectClick: (project: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
      {projects.map((p) => {
        const name = projectName(p.project);
        return (
          <button
            key={p.project}
            onClick={() => onProjectClick(p.project)}
            className="hover-lift group relative overflow-hidden rounded-xl bg-gradient-to-br from-terminal-surface via-terminal-surface to-terminal-bg/70 p-4 text-left shadow-layer-sm transition-all duration-200 ease-material hover:bg-terminal-surface-hover"
          >
            <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-gradient-to-b from-terminal-green to-terminal-blue opacity-50 transition-opacity group-hover:opacity-100" />
            <span className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-terminal-green/5 blur-2xl opacity-0 transition-opacity group-hover:opacity-100" />
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
                <span className="text-terminal-orange tabular-nums">${p.cost.toFixed(2)}</span>
              )}
              <span className="text-terminal-green tabular-nums">
                {fmtNum(p.prompts)}{" "}
                <span className="text-terminal-dimmer">{plural(p.prompts, "prompt")}</span>
              </span>
            </div>
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
                  {p.memoryFileCount}{" "}
                  {p.memoryFileCount === 1 ? "Claude memory" : "Claude memories"}
                </span>
              )}
            </div>
            <MiniSparkline sessionsPerDay={p.sessionsPerDay} />
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function ProjectsPanel({ onNavigate }: ProjectsPanelProps) {
  const { userInsights, scanStatus } = useScanInsightsContext();
  const [selectedProject, setSelectedProject] = useState<string>(ALL_PROJECTS);
  const [mode, setMode] = useState<PanelMode>("overview");

  const projects = useMemo(() => {
    if (!userInsights) return [];
    const sorted = rollupTopProjects(userInsights.topProjects);
    sorted.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
    return sorted;
  }, [userInsights]);

  const selectedInsight =
    selectedProject === ALL_PROJECTS
      ? null
      : (projects.find((p) => p.project === selectedProject) ?? null);

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

  const openSessionsForProject = (project: string) => {
    onNavigate("sessions");
    setTimeout(() => navigateTo({ tab: "sessions", project }), 50);
  };

  const sidebarProjects: SidebarProject[] = projects.map((p) => ({
    project: p.project,
    sessions: p.sessions,
    lastActivity: p.lastActivity,
  }));

  // Single-project Overview already embeds the timeline; the standalone tab
  // is redundant and dropped. Hot Files stays as its own tab.
  const isSingleProject = selectedProject !== ALL_PROJECTS;
  const visibleTabs = isSingleProject
    ? PROJECT_VIEW_TABS.filter((t) => t.id !== "timeline")
    : PROJECT_VIEW_TABS;
  const activeMode = visibleTabs.some((t) => t.id === mode) ? mode : "overview";
  const projectFilterArg = isSingleProject ? selectedProject : undefined;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation ─── */}
      <ProjectSidebar
        projects={sidebarProjects}
        selected={selectedProject}
        onSelect={(project) => {
          setSelectedProject(project);
          setMode("overview");
        }}
      />

      {/* ─── Right pane: header + tabs + content ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-y-auto">
        {/* Mobile project selector */}
        <div className="md:hidden px-3 pt-3">
          <select
            aria-label="Select project"
            value={selectedProject}
            onChange={(e) => {
              setSelectedProject(e.target.value);
              setMode("overview");
            }}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All projects ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.project} value={p.project}>
                {projectName(p.project)} ({p.sessions})
              </option>
            ))}
          </select>
        </div>

        {/* Header: title + tabs */}
        <div className="px-4 md:px-6 pt-5 pb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-sans font-semibold text-terminal-text truncate">
              {selectedProject === ALL_PROJECTS ? "All Projects" : projectName(selectedProject)}
              {selectedProject === ALL_PROJECTS && (
                <span className="ml-2 text-terminal-dimmer font-normal">({projects.length})</span>
              )}
            </h2>
            {isScanning && (
              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono text-terminal-dim">
                <span className="w-1 h-1 rounded-full bg-terminal-purple animate-pulse" />
                Analyzing... {scanStatus!.scanned}/{scanStatus!.total}
              </div>
            )}
          </div>
          <div className="inline-flex w-fit items-center rounded-xl bg-terminal-surface/80 p-0.5 shadow-layer-sm backdrop-blur-sm">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMode(tab.id)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-sans font-semibold transition-all duration-200 ease-material ${
                  activeMode === tab.id
                    ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                    : "text-terminal-dim hover:text-terminal-text"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="px-4 md:px-6 pb-6 space-y-4">
          {activeMode === "overview" && selectedProject === ALL_PROJECTS && (
            <ProjectsGrid projects={projects} onProjectClick={setSelectedProject} />
          )}
          {activeMode === "overview" && selectedInsight && (
            <>
              <ProjectOverview
                project={selectedProject}
                insight={selectedInsight}
                onOpenSessions={() => openSessionsForProject(selectedProject)}
              />
              <SessionRelationshipsView view="timeline" projectFilter={projectFilterArg} />
            </>
          )}
          {activeMode === "timeline" && (
            <SessionRelationshipsView view="timeline" projectFilter={projectFilterArg} />
          )}
          {activeMode === "files" && (
            <SessionRelationshipsView view="files" projectFilter={projectFilterArg} />
          )}
        </div>
      </div>
    </div>
  );
}
