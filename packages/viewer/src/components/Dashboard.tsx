import { useCallback, useEffect, useRef, useState } from "react";
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
    "claude-code": "bg-terminal-orange-subtle text-terminal-orange",
    cursor: "bg-terminal-blue-subtle text-terminal-blue",
  };
  const cls = colors[provider] || "bg-terminal-surface text-terminal-dim";
  const label = provider === "claude-code" ? "Claude" : provider === "cursor" ? "Cursor" : provider;
  return (
    <span
      className={`text-[10px] font-sans font-medium px-2 py-0.5 rounded-full uppercase tracking-wider ${cls}`}
    >
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
          className="bg-terminal-surface-2 rounded px-2 py-0.5 text-sm font-mono text-terminal-text w-full outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-green/50 transition-shadow duration-200"
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
      <span className="text-sm font-mono text-terminal-text truncate">{title || slug}</span>
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
  isDeleting: _isDeleting,
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
    <div
      className={`bg-terminal-surface rounded-xl px-5 py-4 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material space-y-2.5 shadow-layer-sm hover-lift ${isArchived ? "opacity-50" : ""}`}
    >
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
              className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis transition-colors duration-200 shrink-0"
              title={`View on vibe-replay.com`}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" />
              </svg>
              Synced
            </a>
          )}
          {s.gist?.outdated && onPublishGist && (
            <button
              onClick={onPublishGist}
              disabled={isPublishing}
              className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded bg-terminal-orange-subtle text-terminal-orange hover:bg-terminal-orange-emphasis transition-colors duration-200 disabled:opacity-50 shrink-0"
            >
              {isPublishing ? "Syncing..." : "Out of sync"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onOpen}
            className="px-3.5 py-1.5 text-xs font-sans font-semibold rounded-lg bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 ease-material"
          >
            Open
          </button>
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/80 transition-colors disabled:opacity-50"
            >
              {isRegenerating ? (
                <span className="animate-pulse text-terminal-green">...</span>
              ) : (
                "Redo"
              )}
            </button>
          )}
          {ghAvailable && onPublishGist && !s.gist?.gistId && (
            <button
              onClick={onPublishGist}
              disabled={isPublishing}
              className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-purple hover:bg-terminal-purple-subtle transition-colors duration-200 disabled:opacity-50"
              title="Publish to Gist"
            >
              {isPublishing ? (
                <span className="text-terminal-purple animate-pulse">...</span>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 2v8M5 5l3-3 3 3M3 11v2h10v-2" />
                </svg>
              )}
            </button>
          )}
          {onDelete &&
            (confirmingDelete ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    onDelete();
                    setConfirmingDelete(false);
                  }}
                  className="px-2 py-1.5 text-xs font-mono rounded-md bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-colors duration-200"
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
                className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-red hover:bg-terminal-red-subtle transition-colors duration-200"
                title="Delete"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6.5 7v4M9.5 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
                </svg>
              </button>
            ))}
          {onArchive && (
            <button
              onClick={onArchive}
              className="p-1.5 text-terminal-dim hover:text-terminal-text transition-colors"
              title={isArchived ? "Unarchive" : "Archive"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {/* Row 2: user messages */}
      {(s.messages || (s.firstMessage ? [s.firstMessage] : [])).map((msg, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-xs text-terminal-green shrink-0 mt-px select-none">&gt;</span>
          <p className="text-sm text-terminal-dim line-clamp-1 leading-relaxed">{msg}</p>
        </div>
      ))}
      {/* Row 3: stats bar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim">
          {s.stats.userPrompts} prompts
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-orange-subtle text-terminal-orange">
          {s.stats.toolCalls} tools
        </span>
        {s.stats.durationMs && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim">
            {formatDuration(s.stats.durationMs)}
          </span>
        )}
        {s.stats.costEstimate && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-green-subtle text-terminal-green">
            {formatCost(s.stats.costEstimate)}
          </span>
        )}
        {s.hasAnnotations && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-blue-subtle text-terminal-blue">
            {s.annotationCount} annotation{s.annotationCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {/* Row 4: identity */}
      <div className="flex items-center gap-2 text-xs font-mono text-terminal-dimmer flex-wrap">
        <ProviderBadge provider={s.provider} />
        <span>{s.project}</span>
        <span className="text-terminal-border">&middot;</span>
        <span>{formatDate(s.startTime)}</span>
        {s.model && (
          <>
            <span className="text-terminal-border">&middot;</span>
            <span>{s.model}</span>
          </>
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
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="Paste a Gist ID, Gist URL, or replay JSON URL..."
          className="flex-1 bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2 text-xs font-mono rounded-lg bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-colors duration-200 disabled:opacity-40 font-medium"
        >
          {loading ? "Loading..." : "Open"}
        </button>
      </div>
      {error && <div className="text-xs font-mono text-terminal-red">{error}</div>}
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
  const branch =
    s.gitBranch && s.gitBranch !== "main" && s.gitBranch !== "master" ? s.gitBranch : undefined;
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
  cleaned = cleaned.replace(
    /Caveat:\s*The messages below were generated by the user while running local commands\.[^.]*/g,
    "",
  );
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
      fetch("/api/archived").then((r) => (r.ok ? r.json() : { slugs: [] })),
    ])
      .then(([data, archive]: [{ sessions: SourceSession[] }, { slugs: string[] }]) => {
        setSources(data.sessions);
        setArchivedSlugs(new Set(archive.slugs));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleArchive = async (slug: string) => {
    const isArchived = archivedSlugs.has(slug);
    await fetch(`/api/archive/${slug}`, { method: isArchived ? "DELETE" : "POST" });
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      isArchived ? next.delete(slug) : next.add(slug);
      return next;
    });
  };

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (titleInput) titleInputRef.current?.focus();
  }, [titleInput]);

  const handleTitleSave = async (slug: string, title: string) => {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error("Failed to update title");
    // Update the replay summary inside sources so the UI reflects the change
    setSources((prev) =>
      prev.map((s) =>
        s.slug === slug && s.replay
          ? { ...s, replay: { ...s.replay, title: title || undefined } }
          : s,
      ),
    );
  };

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
    byProject.get(s.project)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.timestamp || "";
    const bTime = b[1][0]?.timestamp || "";
    return bTime.localeCompare(aTime);
  });

  // Compute disambiguated labels for projects
  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Filter sessions within selected project
  const projectSessions =
    selectedProject === ALL_PROJECTS ? visibleSources : byProject.get(selectedProject) || [];

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
            className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
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
          <div className="text-terminal-dimmer font-mono text-xs">
            Start a coding session with Claude Code or Cursor, then come back here
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation (hidden on mobile) ─── */}
      <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
            Projects
          </span>
          <button
            onClick={loadSources}
            className="p-1.5 rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
            title="Refresh"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
              <path d="M12.5 1v3h-3M3.5 15v-3h3" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All projects */}
          <button
            onClick={() => setSelectedProject(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-2.5 text-xs font-mono rounded-lg transition-all duration-200 ease-material flex items-center justify-between ${
              selectedProject === ALL_PROJECTS
                ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All projects</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProject === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {sources.length}
            </span>
          </button>

          <div className="h-px bg-terminal-border-subtle mx-2 my-1.5" />

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
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 ease-material group ${
                  isActive
                    ? "bg-terminal-green-subtle shadow-layer-sm"
                    : "hover:bg-terminal-surface"
                } ${!exists ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className={`text-xs font-mono truncate flex items-center gap-1.5 ${
                      isActive
                        ? "text-terminal-green font-medium"
                        : !exists
                          ? "text-terminal-dim"
                          : "text-terminal-text group-hover:text-terminal-text"
                    }`}
                  >
                    {isGit && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className={`shrink-0 ${isActive ? "opacity-70" : "opacity-40"}`}
                      >
                        <path
                          fillRule="evenodd"
                          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                        />
                      </svg>
                    )}
                    {label}
                  </span>
                  <span
                    className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs shrink-0 ${
                      isActive
                        ? "bg-terminal-green-emphasis text-terminal-green"
                        : "bg-terminal-surface text-terminal-dimmer"
                    }`}
                  >
                    {sessions.length}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 ml-0.5">
                  <span
                    className={`text-xs font-mono truncate ${isActive ? "text-terminal-dim" : "text-terminal-dimmer"}`}
                  >
                    {timeAgo(sessions[0]?.timestamp || "")}
                  </span>
                  {replayCount > 0 && (
                    <span
                      className={`text-xs font-mono ${isActive ? "text-terminal-green" : "text-terminal-dimmer"}`}
                    >
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
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-mono text-terminal-text outline-none shadow-layer-sm"
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
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          {/* Project title for desktop */}
          <div className="hidden md:flex items-center justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-mono text-terminal-text truncate font-semibold">
                {selectedProject === ALL_PROJECTS
                  ? "All projects"
                  : projectLabels.get(selectedProject) || projectName(selectedProject)}
              </h2>
              {selectedProject !== ALL_PROJECTS && (
                <span className="text-xs font-mono text-terminal-dimmer truncate block mt-0.5">
                  {selectedProject}
                </span>
              )}
            </div>
            <span className="text-xs font-mono text-terminal-dim tabular-nums px-2 py-1 rounded-md bg-terminal-surface">
              {filtered.length} session{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Search + archive toggle */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by branch, title, prompt..."
                className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`shrink-0 px-2.5 py-2 text-xs font-mono rounded-lg transition-colors duration-200 ${
                  showArchived
                    ? "bg-terminal-orange-subtle text-terminal-orange"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
                title={showArchived ? "Hide archived" : `View all (${archivedCount} archived)`}
              >
                {showArchived ? "Active" : "View all"}
              </button>
            )}
          </div>
        </div>

        {/* Error toast */}
        {generateError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-terminal-red-subtle rounded-lg px-3 py-2.5 text-xs font-mono text-terminal-red shrink-0 shadow-layer-sm">
            <span>{generateError}</span>
            <button
              onClick={() => setGenerateError(null)}
              className="ml-auto text-terminal-red/60 hover:text-terminal-red transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {/* Title input */}
        {titleInput && (
          <div className="mx-4 mb-2 bg-terminal-surface rounded-lg px-4 py-3.5 space-y-3 shrink-0 shadow-layer-md">
            <div className="text-xs font-mono text-terminal-dim">
              Title for <span className="text-terminal-text">{titleInput.slug}</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitGenerate();
              }}
              className="flex gap-2"
            >
              <input
                ref={titleInputRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                className="flex-1 bg-terminal-bg rounded-lg px-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-green/40 transition-shadow duration-200"
                placeholder={titleInput.defaultTitle}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setTitleInput(null);
                }}
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-mono rounded-lg bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-colors duration-200 font-medium"
              >
                Generate
              </button>
              <button
                type="button"
                onClick={() => setTitleInput(null)}
                className="px-3 py-2 text-xs font-mono rounded-lg text-terminal-dim hover:text-terminal-text transition-colors"
              >
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
            <div className="space-y-2.5 px-4 py-3">
              {filtered.map((s) => {
                // Sessions with replay: use the shared ReplayCard
                if (s.replay) {
                  const isArchived = archivedSlugs.has(s.slug);
                  return (
                    <ReplayCard
                      key={`${s.provider}-${s.slug}`}
                      summary={s.replay}
                      onOpen={() => navigateTo({ view: null, session: s.existingReplay! })}
                      onTitleSave={handleTitleSave}
                      onRegenerate={() => handleGenerate(s)}
                      isRegenerating={generatingSlug === s.slug}
                      onArchive={() => toggleArchive(s.slug)}
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
                    className={`bg-terminal-surface rounded-xl px-5 py-4 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material space-y-2.5 shadow-layer-sm hover-lift ${isArchived ? "opacity-50" : ""}`}
                  >
                    {/* Row 1: slug + branch + time + action */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-terminal-text truncate">
                        {label.primary}
                      </span>
                      {label.branch && (
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-terminal-surface-2 text-terminal-dim shrink-0 flex items-center gap-0.5">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <circle cx="5" cy="4" r="2" />
                            <circle cx="11" cy="12" r="2" />
                            <path d="M5 6v4c0 1.1.9 2 2 2h2" />
                          </svg>
                          {label.branch}
                        </span>
                      )}
                      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                        <span className="text-xs font-mono text-terminal-dimmer">
                          {timeAgo(s.timestamp)}
                        </span>
                        <button
                          onClick={() => handleGenerate(s)}
                          disabled={generatingSlug === s.slug}
                          className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-colors duration-200 disabled:opacity-50 font-medium"
                        >
                          {generatingSlug === s.slug ? (
                            <span className="animate-pulse">Generating...</span>
                          ) : (
                            "Generate"
                          )}
                        </button>
                        <button
                          onClick={() => toggleArchive(s.slug)}
                          className="p-1 text-terminal-dim hover:text-terminal-text transition-colors"
                          title={isArchived ? "Unarchive" : "Archive"}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* Row 2: user prompts */}
                    {prompts.map((p, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <span className="text-xs text-terminal-green shrink-0 mt-px select-none">
                          &gt;
                        </span>
                        <p className="text-sm text-terminal-dim line-clamp-1 leading-relaxed">
                          {p}
                        </p>
                      </div>
                    ))}
                    {/* Row 3: meta */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <ProviderBadge provider={s.provider} />
                      {selectedProject === ALL_PROJECTS && (
                        <span
                          className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim"
                          title={s.project}
                        >
                          {projectLabels.get(s.project) || projectName(s.project)}
                        </span>
                      )}
                      <span className="text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                        {formatSize(s.fileSize)}
                      </span>
                      {s.filePaths.length > 1 && (
                        <span className="text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                          {s.filePaths.length} parts
                        </span>
                      )}
                      {s.hasSqlite && (
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-green-subtle text-terminal-green">
                          db
                        </span>
                      )}
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
  const [selectedProject, setSelectedProject] = useState<string>(ALL_PROJECTS);

  useEffect(() => {
    Promise.all([
      fetch("/api/sessions").then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      }),
      fetch("/api/archived").then((r) => (r.ok ? r.json() : { slugs: [] })),
    ])
      .then(([data, archive]: [SessionSummary[], { slugs: string[] }]) => {
        setSessions(data);
        setArchivedSlugs(new Set(archive.slugs));
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

  const toggleArchive = async (slug: string) => {
    const isArchived = archivedSlugs.has(slug);
    await fetch(`/api/archive/${slug}`, { method: isArchived ? "DELETE" : "POST" });
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      isArchived ? next.delete(slug) : next.add(slug);
      return next;
    });
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
            ? {
                ...s,
                gist: {
                  gistId: result.gistId,
                  viewerUrl: result.viewerUrl,
                  updatedAt: new Date().toISOString(),
                  outdated: false,
                },
              }
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
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((s) => !archivedSlugs.has(s.slug));

  // Group by project, sorted by most recent
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of visibleSessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.startTime || "";
    const bTime = b[1][0]?.startTime || "";
    return bTime.localeCompare(aTime);
  });

  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Filter within selected project
  const projectSessions =
    selectedProject === ALL_PROJECTS ? visibleSessions : byProject.get(selectedProject) || [];

  const filtered = filter
    ? projectSessions.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.project.toLowerCase().includes(filter.toLowerCase()) ||
          s.provider.toLowerCase().includes(filter.toLowerCase()) ||
          (s.firstMessage || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : projectSessions;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  // Non-server or empty: show simple centered layout
  if (!serverAvailable || sessions.length === 0) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
          <OpenReplayForm />
          {serverAvailable && sessions.length === 0 && (
            <div className="text-center py-12 space-y-2">
              <div className="text-terminal-dim font-mono text-sm">No replays yet</div>
              <div className="text-terminal-dimmer font-mono text-xs">
                Go to the Sessions tab to generate your first replay
              </div>
            </div>
          )}
          {!serverAvailable && (
            <div className="text-center py-8 space-y-2">
              <div className="text-terminal-dimmer font-mono text-xs">
                Or run <span className="text-terminal-green">npx vibe-replay</span> to create a
                replay from your AI coding sessions
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation (hidden on mobile) ─── */}
      <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
            Projects
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All projects */}
          <button
            onClick={() => setSelectedProject(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-2.5 text-xs font-mono rounded-lg transition-all duration-200 ease-material flex items-center justify-between ${
              selectedProject === ALL_PROJECTS
                ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All replays</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProject === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {visibleSessions.length}
            </span>
          </button>

          <div className="h-px bg-terminal-border-subtle mx-2 my-1.5" />

          {/* Per-project items */}
          {projectEntries.map(([project, replays]) => {
            const isActive = selectedProject === project;
            const label = projectLabels.get(project) || projectName(project);
            const publishedCount = replays.filter((s) => s.gist?.gistId).length;
            return (
              <button
                key={project}
                onClick={() => setSelectedProject(project)}
                title={project}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 ease-material group ${
                  isActive
                    ? "bg-terminal-green-subtle shadow-layer-sm"
                    : "hover:bg-terminal-surface"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className={`text-xs font-mono truncate ${
                      isActive
                        ? "text-terminal-green font-medium"
                        : "text-terminal-text group-hover:text-terminal-text"
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
                    {replays.length}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 ml-0.5">
                  <span
                    className={`text-xs font-mono truncate ${isActive ? "text-terminal-dim" : "text-terminal-dimmer"}`}
                  >
                    {timeAgo(replays[0]?.startTime || "")}
                  </span>
                  {publishedCount > 0 && (
                    <span
                      className={`text-xs font-mono ${isActive ? "text-terminal-purple" : "text-terminal-dimmer"}`}
                    >
                      {publishedCount} published
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Right: replay list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile project selector (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3">
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-mono text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All replays ({visibleSessions.length})</option>
            {projectEntries.map(([project, replays]) => (
              <option key={project} value={project}>
                {projectLabels.get(project) || projectName(project)} ({replays.length})
              </option>
            ))}
          </select>
        </div>

        {/* Header + search */}
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          {/* Open by URL/Gist */}
          <OpenReplayForm />

          {/* Project title for desktop */}
          <div className="hidden md:flex items-center justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-mono text-terminal-text truncate font-semibold">
                {selectedProject === ALL_PROJECTS
                  ? "All replays"
                  : projectLabels.get(selectedProject) || projectName(selectedProject)}
              </h2>
              {selectedProject !== ALL_PROJECTS && (
                <span className="text-xs font-mono text-terminal-dimmer truncate block mt-0.5">
                  {selectedProject}
                </span>
              )}
            </div>
            <span className="text-xs font-mono text-terminal-dim tabular-nums px-2 py-1 rounded-md bg-terminal-surface">
              {filtered.length} replay{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Search + archive toggle */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter replays..."
                className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`shrink-0 px-2.5 py-2 text-xs font-mono rounded-lg transition-colors duration-200 ${
                  showArchived
                    ? "bg-terminal-orange-subtle text-terminal-orange"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
                title={showArchived ? "Hide archived" : `View all (${archivedCount} archived)`}
              >
                {showArchived ? "Active" : "View all"}
              </button>
            )}
          </div>
        </div>

        {/* Error toast */}
        {deleteError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-terminal-red-subtle rounded-lg px-3 py-2.5 text-xs font-mono text-terminal-red shrink-0 shadow-layer-sm">
            <span>{deleteError}</span>
            <button
              onClick={() => setDeleteError(null)}
              className="ml-auto text-terminal-red/60 hover:text-terminal-red transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {/* Replay list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {filter ? "No replays match your filter" : "No replays in this project"}
            </div>
          ) : (
            <div className="space-y-2.5 px-4 py-3">
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
                    onArchive={() => toggleArchive(s.slug)}
                    ghAvailable={ghAvailable === true}
                    isPublishing={publishingSlug === s.slug}
                    isArchived={isArchived}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
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
        <div className="shrink-0 px-5 py-3 border-b border-terminal-border-subtle bg-terminal-surface/30">
          <div className="inline-flex items-center rounded-xl bg-terminal-surface p-0.5 shadow-layer-sm">
            <button
              onClick={() => setTab("sessions")}
              className={`px-5 py-2 text-xs font-sans font-semibold rounded-lg transition-all duration-200 ease-material ${
                tab === "sessions"
                  ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Sessions
            </button>
            <button
              onClick={() => setTab("replays")}
              className={`px-5 py-2 text-xs font-sans font-semibold rounded-lg transition-all duration-200 ease-material ${
                tab === "replays"
                  ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Replays
            </button>
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === "sessions" && isEditor ? <SessionsPanel /> : <ReplaysPanel />}
    </div>
  );
}
