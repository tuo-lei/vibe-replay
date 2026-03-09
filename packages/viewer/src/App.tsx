import { useEffect, useMemo, useRef, useState } from "react";
import Dashboard from "./components/Dashboard";
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
  const { prefs, updatePref, togglePref } = useViewPrefs();

  const session = loadState.status === "ready" ? loadState.session : null;
  const viewerMode = loadState.status === "ready" ? loadState.mode : "embedded";
  const gistOwner = loadState.status === "ready" ? loadState.gistOwner : undefined;
  const isEditor = viewerMode === "editor";

  const hasThinking = useMemo(
    () => session?.scenes.some((s) => s.type === "thinking") ?? false,
    [session],
  );

  // Custom mode popover
  const [customOpen, setCustomOpen] = useState(false);
  const customRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!customOpen) return;
    const handler = (e: MouseEvent) => {
      if (customRef.current && !customRef.current.contains(e.target as Node)) {
        setCustomOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [customOpen]);

  if (loadState.status === "loading") {
    return (
      <div className="h-screen bg-terminal-bg flex items-center justify-center">
        <div className="text-terminal-dim font-mono text-sm animate-pulse">Loading session...</div>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="h-screen bg-terminal-bg flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-red font-mono text-sm">{loadState.message}</div>
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
        <header className="border-b border-terminal-border-subtle px-4 md:px-5 py-2.5 md:py-3 flex items-center justify-between shrink-0 bg-terminal-surface/30 backdrop-blur-sm safe-top">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigateTo({ view: null, session: null })}
              className="text-sm font-sans font-bold bg-gradient-to-r from-[#3fb950] to-[#79b8ff] bg-clip-text text-transparent hover:opacity-80 transition-opacity"
            >
              vibe-replay
            </button>
            <span className="inline-flex items-center gap-1 text-[10px] font-sans font-medium px-2 py-0.5 rounded-full bg-terminal-green-subtle text-terminal-green uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Local
            </span>
            <span className="text-terminal-border/40 text-sm select-none">|</span>
            <span className="text-sm font-sans font-medium text-terminal-text">Dashboard</span>
          </div>
          <button
            onClick={toggleTheme}
            className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs transition-colors"
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
      <header className="relative z-30 border-b border-terminal-border-subtle px-4 md:px-5 py-2.5 md:py-3 flex items-center justify-between shrink-0 bg-terminal-surface/30 backdrop-blur-sm safe-top">
        {/* Left: branding + session info */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <a
            href="https://vibe-replay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-sans font-bold shrink-0 hover:opacity-80 transition-opacity bg-gradient-to-r from-[#3fb950] to-[#79b8ff] bg-clip-text text-transparent"
          >
            vibe-replay
          </a>
          {isEditor && (
            <span className="inline-flex items-center gap-1 text-[10px] font-sans font-medium px-2 py-0.5 rounded-full bg-terminal-green-subtle text-terminal-green uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Local
            </span>
          )}
          {showDashboardBack && (
            <>
              <span className="text-terminal-border/40 text-sm select-none">|</span>
              <button
                onClick={() => navigateTo({ view: "dashboard", session: null })}
                className="flex items-center gap-0.5 text-sm font-sans font-medium text-terminal-dim hover:text-terminal-text transition-colors"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 3L5 8l5 5" />
                </svg>
                Dashboard
              </button>
            </>
          )}
          {meta.title && (
            <>
              <span className="hidden md:inline text-terminal-border/40 text-sm select-none">
                |
              </span>
              <span
                className="hidden md:inline text-terminal-text text-xs font-sans font-medium truncate max-w-[300px]"
                title={meta.project}
              >
                {meta.title}
              </span>
            </>
          )}
          <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-terminal-dim">
            {gistOwner && (
              <>
                <span className="text-terminal-border">&middot;</span>
                <a
                  href={`https://github.com/${gistOwner}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  @{gistOwner}
                </a>
              </>
            )}
            {meta.model && (
              <>
                <span className="text-terminal-border">&middot;</span>
                <span className="text-terminal-dim">{meta.model}</span>
              </>
            )}
            {duration && (
              <>
                <span className="text-terminal-border">&middot;</span>
                <span>{duration}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          {/* Dashboard button (editor mode only, when not already navigated from dashboard) */}
          {isEditor && !showDashboardBack && (
            <button
              onClick={() => navigateTo({ view: "dashboard" })}
              className="h-7 px-2.5 flex items-center gap-1.5 rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs font-mono transition-colors"
              title="All replays"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <rect x="1" y="1" width="6" height="6" rx="1" />
                <rect x="9" y="1" width="6" height="6" rx="1" />
                <rect x="1" y="9" width="6" height="6" rx="1" />
                <rect x="9" y="9" width="6" height="6" rx="1" />
              </svg>
              <span className="hidden sm:inline">Dashboard</span>
            </button>
          )}

          {/* Display mode: segmented control — Custom has a popover */}
          <div className="flex items-center h-7 rounded-md overflow-hidden bg-terminal-surface">
            <button
              onClick={() => updatePref("displayMode", "all")}
              className={`h-full px-2.5 text-xs font-mono transition-colors ${
                prefs.displayMode === "all"
                  ? "bg-terminal-green-subtle text-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
              }`}
            >
              All
            </button>
            <button
              onClick={() => updatePref("displayMode", "compact")}
              className={`h-full px-2.5 text-xs font-mono transition-colors ${
                prefs.displayMode === "compact"
                  ? "bg-terminal-green-subtle text-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
              }`}
            >
              Compact
            </button>
            <div ref={customRef} className="relative h-full">
              <button
                onClick={() => {
                  updatePref("displayMode", "custom");
                  setCustomOpen((v) => (prefs.displayMode === "custom" ? !v : true));
                }}
                className={`h-full px-2.5 text-xs font-mono transition-colors ${
                  prefs.displayMode === "custom"
                    ? "bg-terminal-green-subtle text-terminal-green"
                    : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
              >
                Custom
              </button>
              {customOpen && prefs.displayMode === "custom" && (
                <div className="absolute right-0 top-full mt-2 w-44 bg-terminal-surface border border-terminal-border-subtle rounded-xl shadow-layer-xl z-50 py-2 overflow-hidden backdrop-blur-md">
                  <button
                    onClick={() => togglePref("promptsOnly")}
                    className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center text-xs ${
                        prefs.promptsOnly
                          ? "bg-terminal-green-subtle text-terminal-green"
                          : "bg-terminal-surface"
                      }`}
                    >
                      {prefs.promptsOnly ? "\u2713" : ""}
                    </span>
                    Prompts Only
                  </button>
                  <button
                    onClick={() => togglePref("collapseAllTools")}
                    className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center text-xs ${
                        prefs.collapseAllTools
                          ? "bg-terminal-orange-subtle text-terminal-orange"
                          : "bg-terminal-surface"
                      }`}
                    >
                      {prefs.collapseAllTools ? "\u2713" : ""}
                    </span>
                    Collapse Tools
                  </button>
                  {hasThinking && (
                    <button
                      onClick={() => togglePref("hideThinking")}
                      className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded flex items-center justify-center text-xs ${
                          prefs.hideThinking
                            ? "bg-terminal-purple-subtle text-terminal-purple"
                            : "bg-terminal-surface"
                        }`}
                      >
                        {prefs.hideThinking ? "\u2713" : ""}
                      </span>
                      Hide Thinking
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs transition-colors"
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "\u263E" : "\u2600"}
          </button>
        </div>
      </header>
      <Player session={session!} viewPrefs={prefs} viewerMode={viewerMode} />
    </div>
  );
}
