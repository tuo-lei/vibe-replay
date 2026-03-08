import { useMemo, useState, useRef, useEffect } from "react";
import Player from "./components/Player";
import Dashboard from "./components/Dashboard";
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

function navigateTo(params: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.pushState({}, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function App() {
  const loadState = useSessionLoader();
  const { theme, toggleTheme } = useTheme();
  const { prefs, togglePref } = useViewPrefs();

  const session = loadState.status === "ready" ? loadState.session : null;
  const viewerMode = loadState.status === "ready" ? loadState.mode : "embedded";
  const gistOwner = loadState.status === "ready" ? loadState.gistOwner : undefined;
  const isEditor = viewerMode === "editor";

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

  if (loadState.status === "dashboard") {
    return (
      <div className="h-screen bg-terminal-bg flex flex-col overflow-hidden">
        <header className="border-b border-terminal-border/50 px-3 md:px-4 py-2 md:py-2.5 flex items-center justify-between shrink-0 bg-terminal-surface/30 safe-top">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigateTo({ view: null, session: null })}
              className="text-sm font-mono font-bold bg-gradient-to-r from-[#3fb950] to-[#58a6ff] bg-clip-text text-transparent hover:opacity-80 transition-opacity"
            >
              vibe-replay
            </button>
            <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-terminal-green/30 bg-terminal-green/10 text-terminal-green">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Local
            </span>
            <span className="text-terminal-border/60 text-sm select-none">|</span>
            <span className="text-sm font-mono text-terminal-text/80">Dashboard</span>
          </div>
          <button
            onClick={toggleTheme}
            className="h-7 w-7 flex items-center justify-center rounded-md border border-terminal-border/60 bg-terminal-surface text-terminal-dim hover:text-terminal-text text-xs transition-colors"
          >
            {theme === "dark" ? "\u263E" : "\u2600"}
          </button>
        </header>
        <Dashboard />
      </div>
    );
  }

  const { meta } = session!;
  const duration = formatDuration(meta.stats.durationMs);
  // Show back-to-dashboard button when viewing a session via ?session= param
  const showDashboardBack = isEditor && new URLSearchParams(window.location.search).has("session");

  return (
    <div className="h-screen bg-terminal-bg flex flex-col overflow-hidden">
      <header className="border-b border-terminal-border/50 px-3 md:px-4 py-2 md:py-2.5 flex items-center justify-between shrink-0 bg-terminal-surface/30 safe-top">
        {/* Left: branding + session info */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <a
            href="https://vibe-replay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-mono font-bold shrink-0 hover:opacity-80 transition-opacity bg-gradient-to-r from-[#3fb950] to-[#58a6ff] bg-clip-text text-transparent"
          >
            vibe-replay
          </a>
          {isEditor && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-terminal-green/30 bg-terminal-green/10 text-terminal-green">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Local
            </span>
          )}
          {showDashboardBack && (
            <>
              <span className="text-terminal-border/60 text-sm select-none">|</span>
              <button
                onClick={() => navigateTo({ view: "dashboard", session: null })}
                className="flex items-center gap-0.5 text-sm font-mono text-terminal-text/80 hover:text-terminal-text transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3L5 8l5 5" />
                </svg>
                Dashboard
              </button>
            </>
          )}
          {meta.title && (
            <>
              <span className="hidden md:inline text-terminal-border/60 text-sm select-none">|</span>
              <span className="hidden md:inline text-terminal-text/80 text-xs font-mono truncate max-w-[300px]" title={meta.project}>
                {meta.title}
              </span>
            </>
          )}
          <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-terminal-dim">
            {gistOwner && (
              <><span className="text-terminal-border">&middot;</span>
              <a
                href={`https://github.com/${gistOwner}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-terminal-text/60 hover:text-terminal-text transition-colors"
              >@{gistOwner}</a></>
            )}
            {meta.model && (
              <><span className="text-terminal-border">&middot;</span><span className="text-terminal-text/60">{meta.model}</span></>
            )}
            {duration && (
              <><span className="text-terminal-border">&middot;</span><span>{duration}</span></>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          {/* Dashboard button (editor mode only, when not already navigated from dashboard) */}
          {isEditor && !showDashboardBack && (
            <button
              onClick={() => navigateTo({ view: "dashboard" })}
              className="h-7 px-2.5 flex items-center gap-1.5 rounded-md border border-terminal-border/60 bg-terminal-surface text-terminal-dim hover:text-terminal-text text-xs font-mono transition-colors"
              title="All replays"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" />
                <rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" />
              </svg>
              <span className="hidden sm:inline">Dashboard</span>
            </button>
          )}

          {/* View mode: segmented control */}
          <div className="flex items-center h-7 rounded-md overflow-hidden border border-terminal-border/60">
            <button
              onClick={() => { if (prefs.promptsOnly) togglePref("promptsOnly"); }}
              className={`h-full px-2.5 text-xs font-mono transition-colors ${
                !prefs.promptsOnly
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "bg-terminal-surface text-terminal-dim hover:text-terminal-text"
              }`}
            >
              All
            </button>
            <button
              onClick={() => { if (!prefs.promptsOnly) togglePref("promptsOnly"); }}
              className={`h-full px-2.5 text-xs font-mono transition-colors ${
                prefs.promptsOnly
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "bg-terminal-surface text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Prompts
            </button>
          </div>

          {/* Settings dropdown — filters + theme */}
          <div ref={filterRef} className="relative">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className={`h-7 w-7 flex items-center justify-center rounded-md border transition-colors text-xs ${
                filterOpen
                  ? "bg-terminal-green/15 text-terminal-green border-terminal-green/30"
                  : prefs.collapseAllTools || prefs.hideThinking
                    ? "bg-terminal-orange/10 text-terminal-orange border-terminal-orange/30"
                    : "bg-terminal-surface text-terminal-dim border-terminal-border/60 hover:text-terminal-text"
              }`}
              title="Settings"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="4" x2="14" y2="4" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="2" y1="12" x2="14" y2="12" />
                <circle cx="5" cy="4" r="1.5" fill="currentColor" /><circle cx="10" cy="8" r="1.5" fill="currentColor" /><circle cx="6" cy="12" r="1.5" fill="currentColor" />
              </svg>
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-terminal-bg border border-terminal-border rounded-lg shadow-xl z-50 py-1.5 overflow-hidden">
                {!prefs.promptsOnly && (
                  <>
                    <button
                      onClick={() => togglePref("collapseAllTools")}
                      className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                    >
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[10px] ${
                        prefs.collapseAllTools
                          ? "bg-terminal-orange/20 border-terminal-orange/50 text-terminal-orange"
                          : "border-terminal-border"
                      }`}>{prefs.collapseAllTools ? "\u2713" : ""}</span>
                      Collapse Tools
                    </button>
                    {hasThinking && (
                      <button
                        onClick={() => togglePref("hideThinking")}
                        className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[10px] ${
                          prefs.hideThinking
                            ? "bg-terminal-purple/20 border-terminal-purple/50 text-terminal-purple"
                            : "border-terminal-border"
                        }`}>{prefs.hideThinking ? "\u2713" : ""}</span>
                        Hide Thinking
                      </button>
                    )}
                    <div className="border-t border-terminal-border/40 my-1.5" />
                  </>
                )}
                <button
                  onClick={() => { toggleTheme(); setFilterOpen(false); }}
                  className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                >
                  <span className="w-3.5 text-center">{theme === "dark" ? "\u263E" : "\u2600"}</span>
                  {theme === "dark" ? "Light Mode" : "Dark Mode"}
                </button>
              </div>
            )}
          </div>

        </div>
      </header>
      <Player session={session!} viewPrefs={prefs} viewerMode={viewerMode} />
    </div>
  );
}
