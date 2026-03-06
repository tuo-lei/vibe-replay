import { useMemo, useState, useRef, useEffect } from "react";
import Player from "./components/Player";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { useTheme } from "./hooks/useTheme";
import { useViewPrefs } from "./hooks/useViewPrefs";

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export default function App() {
  const loadState = useSessionLoader();
  const { theme, toggleTheme } = useTheme();
  const { prefs, togglePref } = useViewPrefs();

  const session = loadState.status === "ready" ? loadState.session : null;

  const hasThinking = useMemo(
    () => session?.scenes.some((s) => s.type === "thinking") ?? false,
    [session],
  );

  // Mobile filter dropdown
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterOpen]);

  if (loadState.status === "loading") {
    return (
      <div className="h-screen bg-terminal-bg flex items-center justify-center">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">
          Loading session...
        </div>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="h-screen bg-terminal-bg flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-red font-mono text-sm">
            {loadState.message}
          </div>
          <div className="text-terminal-dim font-mono text-xs">
            Use ?gist=&lt;id&gt; or ?url=&lt;replay-json-url&gt; or embed via CLI
          </div>
        </div>
      </div>
    );
  }

  const { meta } = session!;
  const duration = formatDuration(meta.stats.durationMs);

  return (
    <div className="h-screen bg-terminal-bg flex flex-col overflow-hidden">
      <header className="border-b border-terminal-border/50 px-3 md:px-4 py-2 md:py-2.5 flex items-center justify-between shrink-0 bg-terminal-surface/30 safe-top">
        {/* Left: branding + project */}
        <div className="flex items-center gap-3 min-w-0">
          <a
            href="https://vibe-replay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-mono font-bold shrink-0 hover:opacity-80 transition-opacity bg-gradient-to-r from-[#3fb950] to-[#58a6ff] bg-clip-text text-transparent"
          >
            vibe-replay
          </a>
          <span className="hidden md:inline text-terminal-dim text-xs font-mono truncate">
            {meta.project}
          </span>
          {meta.title && (
            <span className="text-terminal-text text-xs truncate hidden sm:inline">
              {meta.title}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
          {/* View mode: segmented control */}
          <div className="flex items-center rounded-md overflow-hidden border border-terminal-border/60">
            <button
              onClick={() => { if (prefs.promptsOnly) togglePref("promptsOnly"); }}
              className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                !prefs.promptsOnly
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "bg-terminal-surface text-terminal-dim hover:text-terminal-text"
              }`}
            >
              All
            </button>
            <button
              onClick={() => { if (!prefs.promptsOnly) togglePref("promptsOnly"); }}
              className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                prefs.promptsOnly
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "bg-terminal-surface text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Prompts
            </button>
          </div>

          {/* Desktop: inline filter buttons */}
          {!prefs.promptsOnly && (
            <button
              onClick={() => togglePref("collapseAllTools")}
              className={`hidden md:inline-flex px-2.5 py-1 text-xs font-mono rounded-md border transition-colors ${
                prefs.collapseAllTools
                  ? "bg-terminal-orange/10 text-terminal-orange border-terminal-orange/30"
                  : "bg-terminal-surface text-terminal-dim border-terminal-border/60 hover:text-terminal-text"
              }`}
            >
              {prefs.collapseAllTools ? "Expand Tools" : "Collapse Tools"}
            </button>
          )}
          {hasThinking && !prefs.promptsOnly && (
            <button
              onClick={() => togglePref("hideThinking")}
              className={`hidden md:inline-flex px-2.5 py-1 text-xs font-mono rounded-md border transition-colors ${
                prefs.hideThinking
                  ? "bg-terminal-purple/10 text-terminal-purple border-terminal-purple/30"
                  : "bg-terminal-surface text-terminal-dim border-terminal-border/60 hover:text-terminal-text"
              }`}
            >
              {prefs.hideThinking ? "Show Thinking" : "Hide Thinking"}
            </button>
          )}

          {/* Mobile: filter dropdown */}
          {!prefs.promptsOnly && (
            <div ref={filterRef} className="relative md:hidden">
              <button
                onClick={() => setFilterOpen((v) => !v)}
                className={`w-8 h-8 flex items-center justify-center rounded-md border transition-colors text-xs ${
                  prefs.collapseAllTools || prefs.hideThinking
                    ? "bg-terminal-orange/10 text-terminal-orange border-terminal-orange/30"
                    : "bg-terminal-surface text-terminal-dim border-terminal-border/60"
                }`}
                title="View filters"
              >
                {"\u2699"}
              </button>
              {filterOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-44 bg-terminal-bg border border-terminal-border rounded-lg shadow-xl z-50 py-1 overflow-hidden">
                  <button
                    onClick={() => { togglePref("collapseAllTools"); setFilterOpen(false); }}
                    className={`w-full text-left px-3 py-2.5 text-xs font-mono transition-colors ${
                      prefs.collapseAllTools
                        ? "text-terminal-orange bg-terminal-orange/5"
                        : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50"
                    }`}
                  >
                    {prefs.collapseAllTools ? "\u2713 Collapse Tools" : "Collapse Tools"}
                  </button>
                  {hasThinking && (
                    <button
                      onClick={() => { togglePref("hideThinking"); setFilterOpen(false); }}
                      className={`w-full text-left px-3 py-2.5 text-xs font-mono transition-colors ${
                        prefs.hideThinking
                          ? "text-terminal-purple bg-terminal-purple/5"
                          : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50"
                      }`}
                    >
                      {prefs.hideThinking ? "\u2713 Hide Thinking" : "Hide Thinking"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="w-8 h-8 flex items-center justify-center rounded-md bg-terminal-surface border border-terminal-border/60 hover:border-terminal-text transition-colors text-sm"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "\u263E" : "\u2600"}
          </button>

          {/* Session info — desktop only */}
          <div className="hidden md:flex items-center gap-1.5 text-xs font-mono text-terminal-dim">
            {meta.model && (
              <span className="text-terminal-text/60">{meta.model}</span>
            )}
            {meta.model && duration && <span className="text-terminal-border">&middot;</span>}
            {duration && <span>{duration}</span>}
            <span className="text-terminal-border">&middot;</span>
            <span className="tabular-nums">{meta.stats.userPrompts}T / {meta.stats.sceneCount}S</span>
          </div>
        </div>
      </header>
      <Player session={session!} viewPrefs={prefs} />
    </div>
  );
}
