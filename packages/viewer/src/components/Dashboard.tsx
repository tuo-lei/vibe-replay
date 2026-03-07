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

function SessionsPanel() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState<{ slug: string; defaultTitle: string } | null>(null);
  const [titleValue, setTitleValue] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const loadSources = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/sources")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load sessions");
        return r.json();
      })
      .then((data: { sessions: SourceSession[] }) => {
        setSources(data.sessions);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);

  useEffect(() => {
    if (titleInput) titleInputRef.current?.focus();
  }, [titleInput]);

  const handleGenerate = async (source: SourceSession) => {
    // Show title input first
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

      // Navigate to the generated replay
      navigateTo({ view: null, session: data.slug });
    } catch (err: any) {
      setGenerateError(err.message);
    } finally {
      setGeneratingSlug(null);
    }
  };

  // Group by project
  const filtered = filter
    ? sources.filter(
        (s) =>
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.project.toLowerCase().includes(filter.toLowerCase()) ||
          s.provider.toLowerCase().includes(filter.toLowerCase()) ||
          s.firstPrompt.toLowerCase().includes(filter.toLowerCase()) ||
          (s.title || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : sources;

  const byProject = new Map<string, SourceSession[]>();
  for (const s of filtered) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)!.push(s);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">
          Scanning for AI sessions...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-3">
        <div className="text-terminal-red font-mono text-sm">{error}</div>
        <button
          onClick={loadSources}
          className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-surface text-terminal-dim border border-terminal-border hover:text-terminal-text transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-terminal-dim">
          {filtered.length} session{filtered.length !== 1 ? "s" : ""} found
          {filter && filtered.length !== sources.length && (
            <span className="text-terminal-dim/50"> (of {sources.length} total)</span>
          )}
        </div>
        <button
          onClick={loadSources}
          className="px-2 py-1 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors"
          title="Refresh"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
            <path d="M12.5 1v3h-3M3.5 15v-3h3" />
          </svg>
        </button>
      </div>

      {/* Search */}
      {sources.length > 5 && (
        <div className="relative">
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
            placeholder="Filter sessions..."
            className="w-full bg-terminal-surface border border-terminal-border rounded-lg pl-9 pr-3 py-2 text-sm font-mono text-terminal-text placeholder:text-terminal-dim/50 outline-none focus:border-terminal-green/50"
          />
        </div>
      )}

      {/* Generate error toast */}
      {generateError && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs font-mono text-red-400">
          <span>{generateError}</span>
          <button onClick={() => setGenerateError(null)} className="ml-auto text-red-400/60 hover:text-red-400">&times;</button>
        </div>
      )}

      {/* Title input modal */}
      {titleInput && (
        <div className="bg-terminal-surface border border-terminal-green/30 rounded-lg px-4 py-3 space-y-3">
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
            <button
              type="submit"
              className="px-4 py-2 text-xs font-mono rounded-lg bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors"
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

      {/* Session cards grouped by project */}
      {[...byProject.entries()].map(([project, projectSessions]) => (
        <div key={project} className="space-y-2">
          <div className="text-xs font-mono text-terminal-text/60 px-1">
            {project}
          </div>
          {projectSessions.map((s) => (
            <div
              key={`${s.provider}-${s.slug}`}
              className="bg-terminal-surface/50 border border-terminal-border/50 rounded-lg px-4 py-3 hover:bg-terminal-surface/80 transition-colors space-y-1.5"
            >
              {/* Title + actions */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-mono text-terminal-text truncate">
                    {s.title || s.slug}
                  </span>
                  {s.existingReplay && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30 shrink-0">
                      Has Replay
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {s.existingReplay ? (
                    <>
                      <button
                        onClick={() => navigateTo({ view: null, session: s.existingReplay! })}
                        className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors"
                      >
                        View Replay
                      </button>
                      <button
                        onClick={() => handleGenerate(s)}
                        disabled={generatingSlug === s.slug}
                        className="px-2.5 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface transition-colors disabled:opacity-50"
                      >
                        {generatingSlug === s.slug ? (
                          <span className="animate-pulse">Generating...</span>
                        ) : "Re-generate"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleGenerate(s)}
                      disabled={generatingSlug === s.slug}
                      className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors disabled:opacity-50"
                    >
                      {generatingSlug === s.slug ? (
                        <span className="animate-pulse">Generating...</span>
                      ) : "Generate Replay"}
                    </button>
                  )}
                </div>
              </div>
              {/* First prompt preview */}
              {s.firstPrompt && (
                <p className="text-[13px] text-terminal-text/70 line-clamp-2">
                  &ldquo;{s.firstPrompt}&rdquo;
                </p>
              )}
              {/* Metadata */}
              <div className="flex items-center gap-2 text-xs font-mono text-terminal-dim flex-wrap">
                <ProviderBadge provider={s.provider} />
                <span>{formatDate(s.timestamp)}</span>
                <span className="text-terminal-border">&middot;</span>
                <span>{s.lineCount}L</span>
                <span className="text-terminal-border">&middot;</span>
                <span>{formatSize(s.fileSize)}</span>
                {s.filePaths.length > 1 && (
                  <><span className="text-terminal-border">&middot;</span><span>{s.filePaths.length} parts</span></>
                )}
                {s.hasSqlite && (
                  <span className="text-green-400">db</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Empty states */}
      {sources.length === 0 && (
        <div className="text-center py-12 space-y-2">
          <div className="text-terminal-dim font-mono text-sm">No AI sessions found</div>
          <div className="text-terminal-dim/50 font-mono text-xs">
            Start a coding session with Claude Code or Cursor, then come back here
          </div>
        </div>
      )}
      {sources.length > 0 && filtered.length === 0 && (
        <div className="text-center py-8 text-terminal-dim font-mono text-sm">
          No sessions match your filter
        </div>
      )}
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
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [publishingSlug, setPublishingSlug] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data: SessionSummary[]) => {
        setSessions(data);
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
        setDeletingSlug(null);
        return;
      }
      setSessions((prev) => prev.filter((s) => s.slug !== slug));
    } catch {
      setDeleteError("Failed to delete session");
    } finally {
      setDeletingSlug(null);
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

  const filtered = filter
    ? sessions.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.project.toLowerCase().includes(filter.toLowerCase()) ||
          s.provider.toLowerCase().includes(filter.toLowerCase()) ||
          (s.firstMessage || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : sessions;

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
          {/* Search */}
          <div className="relative">
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

          {/* Session cards */}
          <div className="space-y-2">
            {filtered.map((s) => (
              <div
                key={s.slug}
                className="bg-terminal-surface/50 border border-terminal-border/50 rounded-lg px-4 py-3 hover:bg-terminal-surface/80 transition-colors space-y-1.5"
              >
                {/* Primary: title + actions */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <EditableTitle
                      slug={s.slug}
                      title={s.title}
                      onSave={handleTitleSave}
                    />
                    {s.gist && !s.gist.outdated && (
                      <a
                        href={s.gist.viewerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-purple-500/15 text-purple-400 border-purple-500/30 hover:bg-purple-500/25 transition-colors shrink-0"
                        title={`View on vibe-replay.com · synced ${new Date(s.gist.updatedAt).toLocaleDateString()}`}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" /></svg>
                        Synced
                      </a>
                    )}
                    {s.gist?.outdated && (
                      <button
                        onClick={() => handlePublishGist(s.slug)}
                        disabled={publishingSlug === s.slug}
                        className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/25 transition-colors disabled:opacity-50 shrink-0"
                        title={`Local changes since last sync (${new Date(s.gist.updatedAt).toLocaleDateString()}) · click to update`}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 2v8M5 5l3-3 3 3M3 11v2h10v-2" /></svg>
                        {publishingSlug === s.slug ? "Syncing..." : "Out of sync"}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => handleOpen(s.slug)}
                      className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-green/10 text-terminal-green border border-terminal-green/20 hover:bg-terminal-green/20 transition-colors"
                    >
                      Open
                    </button>
                    {ghAvailable && !s.gist?.gistId && (
                      <button
                        onClick={() => handlePublishGist(s.slug)}
                        disabled={publishingSlug === s.slug}
                        className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-purple-400 hover:bg-purple-500/10 transition-colors disabled:opacity-50"
                        title="Publish to GitHub Gist"
                      >
                        {publishingSlug === s.slug ? (
                          <span className="text-purple-400 animate-pulse">Publishing...</span>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v8M5 5l3-3 3 3M3 11v2h10v-2" /></svg>
                        )}
                      </button>
                    )}
                    {deletingSlug === s.slug ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => confirmDelete(s.slug)}
                          className="px-2 py-1.5 text-xs font-mono rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeletingSlug(null)}
                          className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-terminal-text transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingSlug(s.slug)}
                        className="px-2 py-1.5 text-xs font-mono rounded-md text-terminal-dim hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Delete replay"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6.5 7v4M9.5 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {/* Secondary: first message */}
                {s.firstMessage && (
                  <p className="text-[13px] text-terminal-text/70 line-clamp-3">{s.firstMessage}</p>
                )}
                {/* Tertiary: metadata */}
                <div className="flex items-center gap-2 text-xs font-mono text-terminal-dim flex-wrap">
                  <ProviderBadge provider={s.provider} />
                  <span>{s.slug}</span>
                  <span className="text-terminal-border">&middot;</span>
                  <span>{s.project}</span>
                  <span className="text-terminal-border">&middot;</span>
                  <span>{formatDate(s.startTime)}</span>
                  {s.model && (
                    <><span className="text-terminal-border">&middot;</span><span>{s.model}</span></>
                  )}
                  {s.stats.durationMs && (
                    <><span className="text-terminal-border">&middot;</span><span>{formatDuration(s.stats.durationMs)}</span></>
                  )}
                  {s.stats.costEstimate && (
                    <><span className="text-terminal-border">&middot;</span><span>{formatCost(s.stats.costEstimate)}</span></>
                  )}
                  <span className="text-terminal-border">&middot;</span>
                  <span>{s.stats.sceneCount} scenes</span>
                  <span>{s.stats.userPrompts} prompts</span>
                  <span>{s.stats.toolCalls} tools</span>
                  {s.hasAnnotations && (
                    <span className="text-terminal-orange">
                      {s.annotationCount} annotation{s.annotationCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
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
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Tab bar — only show when running with local server */}
        {isEditor && (
          <div className="flex border-b border-terminal-border/50">
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
        {tab === "sessions" && isEditor ? <SessionsPanel /> : <ReplaysPanel />}
      </div>
    </div>
  );
}
