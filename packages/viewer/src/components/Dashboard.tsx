import { useState, useEffect, useRef, useCallback } from "react";
import type { SessionSummary, SourceSession } from "../types";

type Tab = "sessions" | "replays";

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatCost(cost?: number): string {
  if (!cost) return "";
  return `$${cost.toFixed(2)}`;
}

function formatSize(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`;
}

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    "claude-code": "bg-amber-500/15 text-amber-400 border-amber-500/30",
    cursor: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  };
  const cls = colors[provider] || "bg-gray-500/15 text-gray-400 border-gray-500/30";
  const label = provider === "claude-code" ? "Claude" : provider === "cursor" ? "Cursor" : provider;
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

function EditableTitle({
  slug,
  title,
  onSave,
}: {
  slug: string;
  title?: string;
  onSave: (slug: string, title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title || "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(title || "");
  }, [title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(slug, value.trim());
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex items-center gap-1.5 min-w-0"
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setValue(title || "");
              setEditing(false);
            }
          }}
          className="bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-sm font-mono text-terminal-text w-full outline-none focus:border-terminal-green/50"
          placeholder={slug}
          disabled={saving}
        />
      </form>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1 min-w-0 text-left"
      title="Click to edit title"
    >
      <span className="text-sm font-mono text-terminal-text truncate">
        {title || slug}
      </span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="shrink-0 text-terminal-dim opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" />
      </svg>
    </button>
  );
}

/** Shared card for displaying a replay — used by both Sessions and Replays tabs */
function ReplayCard({
  summary: s,
  onOpen,
  onTitleSave,
  onDelete,
  onPublishGist,
  onRegenerate,
  onArchive,
  ghAvailable,
  isPublishing,
  isDeleting,
  isRegenerating,
  isArchived,
}: {
  summary: SessionSummary;
  onOpen: () => void;
  onTitleSave?: (slug: string, title: string) => Promise<void>;
  onDelete?: () => void;
  onPublishGist?: () => void;
  onRegenerate?: () => void;
  onArchive?: () => void;
  ghAvailable?: boolean;
  isPublishing?: boolean;
  isDeleting?: boolean;
  isRegenerating?: boolean;
  isArchived?: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className={`bg-terminal-surface/50 border border-terminal-border/50 rounded-lg px-4 py-3 hover:bg-terminal-surface/80 transition-colors space-y-1.5 ${isArchived ? "opacity-50" : ""}`}>
      {/* Row 1: title + badges + actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {onTitleSave ? (
            <EditableTitle slug={s.slug} title={s.title} onSave={onTitleSave} />
          ) : (
            <span className="text-sm font-mono text-terminal-text truncate">
              {s.title || s.slug}
            </span>
          )}
          {s.gist && !s.gist.outdated && (
            <a
              href={s.gist.viewerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-purple-500/15 text-purple-400 border-purple-500/30 hover:bg-purple-500/25 transition-colors shrink-0"
              title={`View on vibe-replay.com`}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" /></svg>
              Synced
            </a>
          )}
          {s.gist?.outdated && onPublishGist && (
            <button
              onClick={onPublishGist}
              disabled={isPublishing}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/25 transition-colors disabled:opacity-50 shrink-0"
            >
              {isPublishing ? "Syncing..." : "Out of sync"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onOpen}
            className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors"
          >
            Open
          </button>
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              className="px-2 py-1.5 text-[11px] font-mono rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/80 transition-colors disabled:opacity-50"
            >
              {isRegenerating ? <span className="animate-pulse text-terminal-green">...</span> : "Redo"}
            </button>
          )}
          {ghAvailable && onPublishGist && !s.gist?.gistId && (
            <button
              onClick={onPublishGist}
              disabled={isPublishing}
              className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-purple-400 hover:bg-purple-500/10 transition-colors disabled:opacity-50"
              title="Publish to Gist"
            >
              {isPublishing ? (
                <span className="text-purple-400 animate-pulse">...</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v8M5 5l3-3 3 3M3 11v2h10v-2" /></svg>
              )}
            </button>
          )}
          {onDelete && (
            confirmingDelete ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { onDelete(); setConfirmingDelete(false); }}
                  className="px-2 py-1.5 text-xs font-mono rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6.5 7v4M9.5 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
                </svg>
              </button>
            )
          )}
          {onArchive && (
            <button
              onClick={onArchive}
              className="p-1.5 text-terminal-dim hover:text-terminal-text transition-colors"
              title={isArchived ? "Unarchive" : "Archive"}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {/* Row 2: user messages */}
      {(s.messages || (s.firstMessage ? [s.firstMessage] : [])).map((msg, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-[11px] text-terminal-green/60 shrink-0 mt-px select-none">&gt;</span>
          <p className="text-[13px] text-terminal-text/60 line-clamp-1 leading-relaxed">{msg}</p>
        </div>
      ))}
      {/* Row 3: identity */}
      <div className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-dim/50 flex-wrap">
        <ProviderBadge provider={s.provider} />
        <span>{s.slug}</span>
        <span className="text-terminal-dim/30">&middot;</span>
        <span>{s.project}</span>
        <span className="text-terminal-dim/30">&middot;</span>
        <span>{formatDate(s.startTime)}</span>
        {s.model && (
          <><span className="text-terminal-dim/30">&middot;</span><span>{s.model}</span></>
        )}
      </div>
      {/* Row 4: stats */}
      <div className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-dim/40 flex-wrap">
        <span>{s.stats.sceneCount} scenes</span>
        <span>{s.stats.userPrompts} prompts</span>
        <span>{s.stats.toolCalls} tools</span>
        {s.stats.durationMs && (
          <><span className="text-terminal-dim/30">&middot;</span><span>{formatDuration(s.stats.durationMs)}</span></>
        )}
        {s.stats.costEstimate && (
          <><span className="text-terminal-dim/30">&middot;</span><span>{formatCost(s.stats.costEstimate)}</span></>
        )}
        {s.hasAnnotations && (
          <><span className="text-terminal-dim/30">&middot;</span><span className="text-terminal-orange">{s.annotationCount} annotation{s.annotationCount !== 1 ? "s" : ""}</span></>
        )}
      </div>
    </div>
  );
}

/** Open a replay by URL or Gist ID */
function OpenReplayForm() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = input.trim();
    if (!val) return;

    setLoading(true);
    setError(null);

    // Detect gist ID (hex, 20-40 chars)
    if (/^[a-f0-9]{20,40}$/.test(val)) {
      window.location.search = `?gist=${val}`;
      return;
    }

    // Detect gist URL: https://gist.github.com/user/id
    const gistMatch = val.match(/gist\.github\.com\/[^/]+\/([a-f0-9]{20,40})/);
    if (gistMatch) {
      window.location.search = `?gist=${gistMatch[1]}`;
      return;
    }

    // Detect vibe-replay.com viewer URL with gist param
    const viewerMatch = val.match(/[?&]gist=([a-f0-9]{20,40})/);
    if (viewerMatch) {
      window.location.search = `?gist=${viewerMatch[1]}`;
      return;
    }

    // Treat as JSON URL
    try {
      new URL(val);
      window.location.search = `?url=${encodeURIComponent(val)}`;
    } catch {
      setError("Enter a valid URL or Gist ID");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          placeholder="Paste a Gist ID, Gist URL, or replay JSON URL..."
          className="flex-1 bg-terminal-surface border border-terminal-border rounded-lg px-3 py-2 text-sm font-mono text-terminal-text placeholder:text-terminal-dim/50 outline-none focus:border-terminal-green/50"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2 text-xs font-mono rounded-lg bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors disabled:opacity-40"
        >
          {loading ? "Loading..." : "Open"}
        </button>
      </div>
      {error && (
        <div className="text-xs font-mono text-terminal-red">{error}</div>
      )}
    </form>
  );
}

function navigateTo(params: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.pushState({}, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ─── Sessions Tab (source sessions from providers) ─────────────────

/** Relative time like "2h ago", "3d ago" */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

/** Extract the short project name from a path like ~/Code/vibe-replay */
function projectName(project: string): string {
  const parts = project.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || project;
}

/** Compute display labels for project paths — always show path, truncated if needed */
function computeProjectLabels(projects: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const p of projects) {
    labels.set(p, shortenPath(p));
  }
  return labels;
}

/** Shorten a path to fit the sidebar, keeping first + last meaningful segments */
function shortenPath(path: string): string {
  const MAX = 26;
  if (path.length <= MAX) return path;

  const parts = path.split("/");
  if (parts.length <= 2) return path;

  // Try first + last two segments: ~/…/parent/name
  const first = parts[0];
  const lastTwo = parts.slice(-2).join("/");
  const candidate = `${first}/\u2026/${lastTwo}`;
  if (candidate.length <= MAX) return candidate;

  // Just first + last
  const last = parts[parts.length - 1];
  return `${first}/\u2026/${last}`;
}

/** Build a human-readable session label — slug is always the primary identifier */
function sessionLabel(s: SourceSession): { primary: string; branch?: string } {
  const branch = s.gitBranch && s.gitBranch !== "main" && s.gitBranch !== "master"
    ? s.gitBranch : undefined;
  if (s.title && s.title !== s.slug) {
    return { primary: s.title, branch };
  }
  return { primary: s.slug, branch };
}

/** Strip system-injected noise from first prompt for display */
function cleanPrompt(text: string): string {
  let cleaned = text;
  // Strip XML tags (opening and closing, including truncated ones)
  cleaned = cleaned.replace(/<\/?[a-z][a-z0-9-]*>/gi, "");
  // Strip known Claude Code boilerplate from local command injection
  cleaned = cleaned.replace(/Caveat:\s*The messages below were generated by the user while running local commands\.[^.]*/g, "");
  cleaned = cleaned.replace(/DO NOT respond to these messages[^.]*/g, "");
  // Remove slash commands
  cleaned = cleaned.replace(/^\/\w+\s*/g, "");
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

/** "All projects" sentinel */
const ALL_PROJECTS = "__all__";

function SessionsPanel() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string>(ALL_PROJECTS);
  const [filter, setFilter] = useState("");
  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState<{ slug: string; defaultTitle: string } | null>(null);
  const [titleValue, setTitleValue] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [archivedSlugs, setArchivedSlugs] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  const loadSources = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch("/api/sources").then((r) => {
        if (!r.ok) throw new Error("Failed to load sessions");
        return r.json();
      }),
      fetch("/api/archived").then((r) => r.ok ? r.json() : { sessions: [] }),
    ])
      .then(([data, archive]: [{ sessions: SourceSession[] }, { sessions: string[] }]) => {
        setSources(data.sessions);
        setArchivedSlugs(new Set(archive.sessions));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const archiveSession = async (slug: string) => {
    await fetch(`/api/archive/sessions/${slug}`, { method: "POST" });
    setArchivedSlugs((prev) => new Set([...prev, slug]));
  };

  const unarchiveSession = async (slug: string) => {
    await fetch(`/api/archive/sessions/${slug}`, { method: "DELETE" });
    setArchivedSlugs((prev) => { const next = new Set(prev); next.delete(slug); return next; });
  };

  useEffect(() => { loadSources(); }, [loadSources]);

  useEffect(() => {
    if (titleInput) titleInputRef.current?.focus();
  }, [titleInput]);

  const handleGenerate = (source: SourceSession) => {
    setTitleInput({ slug: source.slug, defaultTitle: source.title || source.slug });
    setTitleValue(source.title || source.slug);
  };

  const submitGenerate = async () => {
    if (!titleInput) return;
    const source = sources.find((s) => s.slug === titleInput.slug);
    if (!source) return;

    setTitleInput(null);
    setGeneratingSlug(source.slug);
    setGenerateError(null);

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: source.provider,
          filePaths: source.filePaths,
          toolPaths: source.toolPaths,
          title: titleValue.trim() || undefined,
          sessionSlug: source.slug,
          sessionProject: source.project,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Generation failed");
      navigateTo({ view: null, session: data.slug });
    } catch (err: any) {
      setGenerateError(err.message);
    } finally {
      setGeneratingSlug(null);
    }
  };

  // Visible sessions (excluding archived unless toggled)
  const archivedCount = sources.filter((s) => archivedSlugs.has(s.slug)).length;
  const visibleSources = showArchived ? sources : sources.filter((s) => !archivedSlugs.has(s.slug));

  // Group by project, sorted by most recent timestamp
  const byProject = new Map<string, SourceSession[]>();
  for (const s of visibleSources) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)!.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.timestamp || "";
    const bTime = b[1][0]?.timestamp || "";
    return bTime.localeCompare(aTime);
  });

  // Compute disambiguated labels for projects
  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Filter sessions within selected project
  const projectSessions = selectedProject === ALL_PROJECTS
    ? visibleSources
    : (byProject.get(selectedProject) || []);

  const filtered = filter
    ? projectSessions.filter(
        (s) =>
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.firstPrompt.toLowerCase().includes(filter.toLowerCase()) ||
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          (s.gitBranch || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : projectSessions;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">
          Scanning for AI sessions...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="text-terminal-red font-mono text-sm">{error}</div>
          <button
            onClick={loadSources}
            className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-surface text-terminal-dim border border-terminal-border hover:text-terminal-text transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-dim font-mono text-sm">No AI sessions found</div>
          <div className="text-terminal-dim/50 font-mono text-xs">
            Start a coding session with Claude Code or Cursor, then come back here
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation (hidden on mobile) ─── */}
      <div className="hidden md:flex w-56 shrink-0 flex-col border-r border-terminal-border/50 bg-terminal-bg">
        <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border/30">
          <span className="text-[11px] font-mono text-terminal-dim uppercase tracking-wider">Projects</span>
          <button
            onClick={loadSources}
            className="p-1 text-terminal-dim hover:text-terminal-text transition-colors"
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
              <path d="M12.5 1v3h-3M3.5 15v-3h3" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* All projects */}
          <button
            onClick={() => setSelectedProject(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors flex items-center justify-between ${
              selectedProject === ALL_PROJECTS
                ? "bg-terminal-green/10 text-terminal-green"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50"
            }`}
          >
            <span>All projects</span>
            <span className="text-terminal-dim/50">{sources.length}</span>
          </button>

          <div className="border-t border-terminal-border/20 my-1" />

          {/* Per-project items */}
          {projectEntries.map(([project, sessions]) => {
            const replayCount = sessions.filter((s) => s.existingReplay).length;
            const isActive = selectedProject === project;
            const label = projectLabels.get(project) || projectName(project);
            const exists = sessions[0]?.projectExists !== false;
            const isGit = sessions.some((s) => s.isGitRepo || s.gitBranch);
            return (
              <button
                key={project}
                onClick={() => setSelectedProject(project)}
                title={project}
                className={`w-full text-left px-3 py-2 transition-colors group ${
                  isActive
                    ? "bg-terminal-green/10"
                    : "hover:bg-terminal-surface/50"
                } ${!exists ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-xs font-mono truncate flex items-center gap-1 ${
                    isActive
                      ? "text-terminal-green"
                      : !exists
                        ? "text-terminal-dim"
                        : "text-terminal-text/80 group-hover:text-terminal-text"
                  }`}>
                    {isGit && (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-50">
                        <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                      </svg>
                    )}
                    {label}
                  </span>
                  <span className={`text-[10px] font-mono shrink-0 ${
                    isActive ? "text-terminal-green/60" : "text-terminal-dim/50"
                  }`}>
                    {sessions.length}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[10px] font-mono text-terminal-dim/40 truncate">
                    {timeAgo(sessions[0]?.timestamp || "")}
                  </span>
                  {replayCount > 0 && (
                    <span className="text-[9px] font-mono text-green-400/50">
                      {replayCount} {replayCount === 1 ? "replay" : "replays"}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Right: session list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile project selector (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3">
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full bg-terminal-surface border border-terminal-border rounded-lg px-3 py-2 text-sm font-mono text-terminal-text outline-none"
          >
            <option value={ALL_PROJECTS}>All projects ({sources.length})</option>
            {projectEntries.map(([project, sessions]) => (
              <option key={project} value={project}>
                {projectLabels.get(project) || projectName(project)} ({sessions.length})
              </option>
            ))}
          </select>
        </div>

        {/* Search + header */}
        <div className="px-4 pt-3 pb-2 space-y-2 shrink-0">
          {/* Project title for desktop */}
          <div className="hidden md:flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-sm font-mono text-terminal-text truncate block">
                {selectedProject === ALL_PROJECTS
                  ? "All projects"
                  : (projectLabels.get(selectedProject) || projectName(selectedProject))}
              </span>
              {selectedProject !== ALL_PROJECTS && (
                <span className="text-[11px] font-mono text-terminal-dim/40 truncate block">{selectedProject}</span>
              )}
            </div>
            <span className="text-xs font-mono text-terminal-dim">
              {filtered.length} session{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Search + archive toggle */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by branch, title, prompt..."
                className="w-full bg-terminal-surface border border-terminal-border rounded-lg pl-9 pr-3 py-2 text-sm font-mono text-terminal-text placeholder:text-terminal-dim/50 outline-none focus:border-terminal-green/50"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`shrink-0 px-2.5 py-2 text-[11px] font-mono rounded-lg border transition-colors ${
                  showArchived
                    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                    : "text-terminal-dim border-terminal-border hover:text-terminal-text"
                }`}
                title={showArchived ? "Hide archived" : `Show ${archivedCount} archived`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="inline-block">
                  <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
                </svg>
                {" "}{archivedCount}
              </button>
            )}
          </div>
        </div>

        {/* Error toast */}
        {generateError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs font-mono text-red-400 shrink-0">
            <span>{generateError}</span>
            <button onClick={() => setGenerateError(null)} className="ml-auto text-red-400/60 hover:text-red-400">&times;</button>
          </div>
        )}

        {/* Title input */}
        {titleInput && (
          <div className="mx-4 mb-2 bg-terminal-surface border border-terminal-green/30 rounded-lg px-4 py-3 space-y-3 shrink-0">
            <div className="text-xs font-mono text-terminal-dim">
              Title for <span className="text-terminal-text">{titleInput.slug}</span>
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); submitGenerate(); }}
              className="flex gap-2"
            >
              <input
                ref={titleInputRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                className="flex-1 bg-terminal-bg border border-terminal-border rounded-lg px-3 py-2 text-sm font-mono text-terminal-text placeholder:text-terminal-dim/50 outline-none focus:border-terminal-green/50"
                placeholder={titleInput.defaultTitle}
                onKeyDown={(e) => { if (e.key === "Escape") setTitleInput(null); }}
              />
              <button type="submit" className="px-4 py-2 text-xs font-mono rounded-lg bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors">
                Generate
              </button>
              <button type="button" onClick={() => setTitleInput(null)} className="px-3 py-2 text-xs font-mono rounded-lg text-terminal-dim hover:text-terminal-text transition-colors">
                Cancel
              </button>
            </form>
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {filter ? "No sessions match your filter" : "No sessions in this project"}
            </div>
          ) : (
            <div className="space-y-2 px-3 py-2">
              {filtered.map((s) => {
                // Sessions with replay: use the shared ReplayCard
                if (s.replay) {
                  const isArchived = archivedSlugs.has(s.slug);
                  return (
                    <ReplayCard
                      key={`${s.provider}-${s.slug}`}
                      summary={s.replay}
                      onOpen={() => navigateTo({ view: null, session: s.existingReplay! })}
                      onRegenerate={() => handleGenerate(s)}
                      isRegenerating={generatingSlug === s.slug}
                      onArchive={() => isArchived ? unarchiveSession(s.slug) : archiveSession(s.slug)}
                      isArchived={isArchived}
                    />
                  );
                }
                // Sessions without replay: simpler card with Generate
                const label = sessionLabel(s);
                const prompts = (s.prompts || [])
                  .map((p) => cleanPrompt(p))
                  .filter((p) => p.length > 0);
                if (prompts.length === 0 && s.firstPrompt) {
                  const cleaned = cleanPrompt(s.firstPrompt);
                  if (cleaned) prompts.push(cleaned);
                }
                const isArchived = archivedSlugs.has(s.slug);
                return (
                  <div
                    key={`${s.provider}-${s.slug}`}
                    className={`bg-terminal-surface/30 border border-terminal-border/30 rounded-lg px-4 py-3 hover:bg-terminal-surface/50 transition-colors space-y-1.5 ${isArchived ? "opacity-50" : ""}`}
                  >
                    {/* Row 1: slug + branch + time + action */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-terminal-text truncate">
                        {label.primary}
                      </span>
                      {label.branch && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-terminal-border/40 text-terminal-dim/70 shrink-0 flex items-center gap-0.5">
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="5" cy="4" r="2" /><circle cx="11" cy="12" r="2" /><path d="M5 6v4c0 1.1.9 2 2 2h2" />
                          </svg>
                          {label.branch}
                        </span>
                      )}
                      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                        <span className="text-[11px] font-mono text-terminal-dim/40">
                          {timeAgo(s.timestamp)}
                        </span>
                        <button
                          onClick={() => handleGenerate(s)}
                          disabled={generatingSlug === s.slug}
                          className="px-3 py-1 text-xs font-mono rounded-md bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors disabled:opacity-50"
                        >
                          {generatingSlug === s.slug ? (
                            <span className="animate-pulse">Generating...</span>
                          ) : "Generate"}
                        </button>
                        <button
                          onClick={() => isArchived ? unarchiveSession(s.slug) : archiveSession(s.slug)}
                          className="p-1 text-terminal-dim hover:text-terminal-text transition-colors"
                          title={isArchived ? "Unarchive" : "Archive"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* Row 2: user prompts */}
                    {prompts.map((p, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <span className="text-[11px] text-terminal-green/60 shrink-0 mt-px select-none">&gt;</span>
                        <p className="text-[13px] text-terminal-text/60 line-clamp-1 leading-relaxed">{p}</p>
                      </div>
                    ))}
                    {/* Row 3: meta */}
                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-dim/50 flex-wrap">
                      <ProviderBadge provider={s.provider} />
                      {selectedProject === ALL_PROJECTS && (
                        <span className="text-terminal-text/40" title={s.project}>
                          {projectLabels.get(s.project) || projectName(s.project)}
                        </span>
                      )}
                      <span>{formatSize(s.fileSize)}</span>
                      {s.filePaths.length > 1 && <span>{s.filePaths.length} parts</span>}
                      {s.hasSqlite && <span className="text-green-400/60">db</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Replays Tab (existing generated replays) ───────────────────────

function ReplaysPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [publishingSlug, setPublishingSlug] = useState<string | null>(null);
  const [archivedSlugs, setArchivedSlugs] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/sessions").then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      }),
      fetch("/api/archived").then((r) => r.ok ? r.json() : { replays: [] }),
    ])
      .then(([data, archive]: [SessionSummary[], { replays?: string[] }]) => {
        setSessions(data);
        setArchivedSlugs(new Set(archive.replays || []));
        setServerAvailable(true);
      })
      .catch(() => {
        setServerAvailable(false);
      })
      .finally(() => setLoading(false));

    fetch("/api/gh-status")
      .then((r) => r.json())
      .then((data: { available: boolean }) => setGhAvailable(data.available))
      .catch(() => setGhAvailable(false));
  }, []);

  const archiveReplay = async (slug: string) => {
    await fetch(`/api/archive/replays/${slug}`, { method: "POST" });
    setArchivedSlugs((prev) => new Set([...prev, slug]));
  };

  const unarchiveReplay = async (slug: string) => {
    await fetch(`/api/archive/replays/${slug}`, { method: "DELETE" });
    setArchivedSlugs((prev) => { const next = new Set(prev); next.delete(slug); return next; });
  };

  const handleTitleSave = async (slug: string, title: string) => {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error("Failed to update title");
    setSessions((prev) =>
      prev.map((s) => (s.slug === slug ? { ...s, title: title || undefined } : s)),
    );
  };

  const handleOpen = (slug: string) => {
    navigateTo({ view: null, session: slug });
  };

  const confirmDelete = async (slug: string) => {
    setDeleteError(null);
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setDeleteError(data.error || "Failed to delete session");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.slug !== slug));
    } catch {
      setDeleteError("Failed to delete session");
    }
  };

  const handlePublishGist = async (slug: string) => {
    setPublishingSlug(slug);
    try {
      const resp = await fetch(`/api/publish/gist?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || "Publish failed");
      }
      const result = await resp.json();
      setSessions((prev) =>
        prev.map((s) =>
          s.slug === slug
            ? { ...s, gist: { gistId: result.gistId, viewerUrl: result.viewerUrl, updatedAt: new Date().toISOString(), outdated: false } }
            : s,
        ),
      );
    } catch (err: any) {
      console.error("Gist publish error:", err.message);
    } finally {
      setPublishingSlug(null);
    }
  };

  const archivedCount = sessions.filter((s) => archivedSlugs.has(s.slug)).length;
  const visibleSessions = showArchived ? sessions : sessions.filter((s) => !archivedSlugs.has(s.slug));

  const filtered = filter
    ? visibleSessions.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.project.toLowerCase().includes(filter.toLowerCase()) ||
          s.provider.toLowerCase().includes(filter.toLowerCase()) ||
          (s.firstMessage || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : visibleSessions;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Open by URL/Gist */}
      <OpenReplayForm />

      {serverAvailable && sessions.length > 0 && (
        <>
          {/* Search + archive toggle */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter replays..."
                className="w-full bg-terminal-surface border border-terminal-border rounded-lg pl-9 pr-3 py-2 text-sm font-mono text-terminal-text placeholder:text-terminal-dim/50 outline-none focus:border-terminal-green/50"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`shrink-0 px-2.5 py-2 text-[11px] font-mono rounded-lg border transition-colors ${
                  showArchived
                    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                    : "text-terminal-dim border-terminal-border hover:text-terminal-text"
                }`}
                title={showArchived ? "Hide archived" : `Show ${archivedCount} archived`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="inline-block">
                  <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
                </svg>
                {" "}{archivedCount}
              </button>
            )}
          </div>

          {/* Error toast */}
          {deleteError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs font-mono text-red-400">
              <span>{deleteError}</span>
              <button onClick={() => setDeleteError(null)} className="ml-auto text-red-400/60 hover:text-red-400">&times;</button>
            </div>
          )}

          {/* Stats bar */}
          <div className="flex items-center gap-3 text-xs font-mono text-terminal-dim">
            <span>
              {filtered.length} <span className="text-terminal-text/70">local</span> replay{filtered.length !== 1 ? "s" : ""}
            </span>
            {filter && filtered.length !== sessions.length && (
              <span className="text-terminal-dim/50">
                (of {sessions.length} total)
              </span>
            )}
            {ghAvailable === true && (
              <span className="text-terminal-green/70">gh authenticated</span>
            )}
            {ghAvailable === false && (
              <span className="text-terminal-dim/50">gh not available</span>
            )}
          </div>

          {/* Replay cards */}
          <div className="space-y-2">
            {filtered.map((s) => {
              const isArchived = archivedSlugs.has(s.slug);
              return (
                <ReplayCard
                  key={s.slug}
                  summary={s}
                  onOpen={() => handleOpen(s.slug)}
                  onTitleSave={handleTitleSave}
                  onDelete={() => confirmDelete(s.slug)}
                  onPublishGist={() => handlePublishGist(s.slug)}
                  onArchive={() => isArchived ? unarchiveReplay(s.slug) : archiveReplay(s.slug)}
                  ghAvailable={ghAvailable === true}
                  isPublishing={publishingSlug === s.slug}
                  isArchived={isArchived}
                />
              );
            })}
          </div>
        </>
      )}

      {/* Empty state */}
      {serverAvailable && sessions.length === 0 && (
        <div className="text-center py-12 space-y-2">
          <div className="text-terminal-dim font-mono text-sm">No replays yet</div>
          <div className="text-terminal-dim/50 font-mono text-xs">
            Go to the Sessions tab to generate your first replay
          </div>
        </div>
      )}

      {!serverAvailable && (
        <div className="text-center py-8 space-y-2">
          <div className="text-terminal-dim/50 font-mono text-xs">
            Or run <span className="text-terminal-green">npx vibe-replay</span> to create a replay from your AI coding sessions
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────

export default function Dashboard() {
  const isEditor = !!window.__VIBE_REPLAY_EDITOR__;
  const [tab, setTab] = useState<Tab>(isEditor ? "sessions" : "replays");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Tab bar — only show when running with local server */}
      {isEditor && (
        <div className="shrink-0 px-4 flex border-b border-terminal-border/50">
          <button
            onClick={() => setTab("sessions")}
            className={`px-4 py-2 text-sm font-mono transition-colors ${
              tab === "sessions"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text"
            }`}
          >
            Sessions
          </button>
          <button
            onClick={() => setTab("replays")}
            className={`px-4 py-2 text-sm font-mono transition-colors ${
              tab === "replays"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text"
            }`}
          >
            Replays
          </button>
        </div>
      )}

      {/* Tab content */}
      {tab === "sessions" && isEditor ? (
        <SessionsPanel />
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
            <ReplaysPanel />
          </div>
        </div>
      )}
    </div>
  );
}
