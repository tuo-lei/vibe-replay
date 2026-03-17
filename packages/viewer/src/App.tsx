import { useEffect, useMemo, useRef, useState } from "react";
import Dashboard from "./components/Dashboard";
import { navigateTo } from "./components/dashboard-utils";
import Player from "./components/Player";
import type { ActiveView } from "./components/ViewTabBar";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { useTheme } from "./hooks/useTheme";
import { useViewPrefs } from "./hooks/useViewPrefs";

function getActiveViewFromUrl(): ActiveView {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("v");
  if (v === "summary" || v === "export") return v;
  return "replay";
}

function GitHubStarButton() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    const a = document.createElement("a");
    a.className = "github-button";
    a.href = "https://github.com/tuo-lei/vibe-replay";
    a.setAttribute("data-color-scheme", "no-preference: dark; light: dark; dark: dark;");
    a.setAttribute("data-icon", "octicon-star");
    a.setAttribute("data-size", "large");
    a.setAttribute("data-show-count", "true");
    a.textContent = "Star";
    el.appendChild(a);
    const script = document.createElement("script");
    script.src = "https://buttons.github.io/buttons.js";
    script.async = true;
    el.appendChild(script);
    return () => {
      el.innerHTML = "";
    };
  }, []);
  return <div ref={ref} className="flex items-center h-7 overflow-hidden" />;
}

export default function App() {
  const loadState = useSessionLoader();
  const { theme, toggleTheme } = useTheme();
  const { prefs, updatePref, togglePref } = useViewPrefs();

  const session = loadState.status === "ready" ? loadState.session : null;
  const viewerMode = loadState.status === "ready" ? loadState.mode : "embedded";
  const gistOwner = loadState.status === "ready" ? loadState.gistOwner : undefined;
  const isEditor = viewerMode === "editor";

  const [activeView, setActiveView] = useState<ActiveView>(getActiveViewFromUrl());
  const returnToLandingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handler = () => setActiveView(getActiveViewFromUrl());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleViewChange = (view: ActiveView) => {
    setActiveView(view);
    navigateTo({ v: view === "replay" ? null : view });
  };

  const hasThinking = useMemo(
    () => session?.scenes.some((s) => s.type === "thinking") ?? false,
    [session],
  );

  // Mobile menu + custom mode dropdown
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const customRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prefs.displayMode !== "custom") setCustomOpen(false);
  }, [prefs.displayMode]);
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
        <div className="text-center space-y-2">
          <div className="text-terminal-green font-sans font-bold text-sm animate-pulse">
            LOADING SESSION...
          </div>
          <div className="text-terminal-dimmer font-mono text-xs">Preparing replay data</div>
        </div>
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
        <header className="border-b border-terminal-border-subtle px-5 pt-5 pb-3 md:py-3 flex items-center justify-between shrink-0 glass-effect z-40 safe-top">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigateTo({ view: null, session: null })}
              className="text-sm font-sans font-bold bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent hover:opacity-80 transition-opacity"
            >
              vibe-replay
            </button>
            <span className="instant-tooltip inline-flex items-center gap-1.5 text-[10px] font-sans font-bold px-2.5 py-1 rounded-full bg-terminal-green/10 text-terminal-green uppercase tracking-wider border border-terminal-green/20">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Live
              <span className="instant-tooltip-text">
                Viewer {window.location.host}
                {import.meta.env.VITE_API_PORT && ` · API :${import.meta.env.VITE_API_PORT}`}
              </span>
            </span>
            <span className="text-terminal-border/40 text-sm select-none">|</span>
            <span className="text-sm font-sans font-semibold text-terminal-text/90">Dashboard</span>
          </div>
          <div className="flex items-center gap-2">
            <GitHubStarButton />
            <button
              onClick={toggleTheme}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs transition-colors"
            >
              {theme === "dark" ? "\u263E" : "\u2600"}
            </button>
          </div>
        </header>
        <Dashboard />
      </div>
    );
  }

  const { meta } = session!;
  // Show back-to-dashboard button when viewing a session via ?session= param
  const showDashboardBack = isEditor && new URLSearchParams(window.location.search).has("session");

  return (
    <div className="h-screen bg-terminal-bg flex flex-col overflow-hidden">
      <header className="relative z-40 border-b border-terminal-border-subtle px-5 pt-5 pb-3 md:py-3 flex items-center justify-between shrink-0 glass-effect safe-top">
        {/* Left: branding + session info */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {isEditor ? (
            <button
              onClick={() => navigateTo({ view: "dashboard", session: null })}
              className="text-sm font-sans font-bold shrink-0 hover:opacity-80 transition-opacity bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent"
            >
              vibe-replay
            </button>
          ) : (
            <a
              href="https://vibe-replay.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-sans font-bold shrink-0 hover:opacity-80 transition-opacity bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent"
            >
              vibe-replay
            </a>
          )}
          {isEditor && (
            <span className="instant-tooltip inline-flex items-center gap-1.5 text-[10px] font-sans font-bold px-2.5 py-1 rounded-full bg-terminal-green/10 text-terminal-green uppercase tracking-wider border border-terminal-green/20">
              <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
              Live
              <span className="instant-tooltip-text">
                Viewer {window.location.host}
                {import.meta.env.VITE_API_PORT && ` · API :${import.meta.env.VITE_API_PORT}`}
              </span>
            </span>
          )}
          {showDashboardBack && (
            <span className="hidden md:flex items-center gap-0.5">
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
            </span>
          )}
          {meta.title && (
            <>
              <span className="text-terminal-border/40 text-sm select-none hidden md:inline">
                |
              </span>
              <button
                type="button"
                onClick={() => {
                  returnToLandingRef.current?.();
                  handleViewChange("replay");
                }}
                className="text-terminal-text text-xs font-sans font-medium truncate max-w-[180px] md:max-w-[300px] hover:text-terminal-green transition-colors"
                title="Back to landing page"
              >
                {meta.title}
              </button>
            </>
          )}
          {gistOwner && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-terminal-dim">
              <span className="text-terminal-border">&middot;</span>
              <span className="text-terminal-dimmer">shared by</span>
              <a
                href={`https://github.com/${gistOwner}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-terminal-dim hover:text-terminal-text transition-colors"
              >
                @{gistOwner}
              </a>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
          {/* Dashboard button (editor mode only, when not already navigated from dashboard) */}
          {isEditor && !showDashboardBack && (
            <button
              onClick={() => navigateTo({ view: "dashboard", session: null })}
              className="h-7 px-2.5 flex items-center gap-1.5 rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs font-sans font-medium transition-colors"
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

          {/* Display mode + Star + Theme — desktop inline */}
          <div ref={customRef} className="hidden md:flex items-center gap-1.5">
            {/* Display mode: segmented control + Custom dropdown */}
            <div className="relative flex items-center">
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
              </div>
              {customOpen && prefs.displayMode === "custom" && (
                <div className="absolute right-0 top-full mt-2 w-40 bg-terminal-surface border border-terminal-border-subtle rounded-xl shadow-layer-xl z-50 py-1.5 backdrop-blur-md">
                  <button
                    onClick={() => togglePref("promptsOnly")}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] ${
                        prefs.promptsOnly
                          ? "bg-terminal-green-subtle text-terminal-green"
                          : "bg-terminal-bg"
                      }`}
                    >
                      {prefs.promptsOnly ? "\u2713" : ""}
                    </span>
                    Prompts Only
                  </button>
                  <button
                    onClick={() => togglePref("collapseAllTools")}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] ${
                        prefs.collapseAllTools
                          ? "bg-terminal-orange-subtle text-terminal-orange"
                          : "bg-terminal-bg"
                      }`}
                    >
                      {prefs.collapseAllTools ? "\u2713" : ""}
                    </span>
                    Tools Collapsed
                  </button>
                  {hasThinking && (
                    <button
                      onClick={() => togglePref("hideThinking")}
                      className="w-full text-left px-3 py-1.5 text-xs font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface/50 transition-colors flex items-center gap-2"
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] ${
                          prefs.hideThinking
                            ? "bg-terminal-purple-subtle text-terminal-purple"
                            : "bg-terminal-bg"
                        }`}
                      >
                        {prefs.hideThinking ? "\u2713" : ""}
                      </span>
                      Thinking Hidden
                    </button>
                  )}
                </div>
              )}
            </div>

            <GitHubStarButton />

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-xs transition-colors"
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? "\u263E" : "\u2600"}
            </button>
          </div>

          {/* Mobile menu button */}
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="md:hidden h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
            aria-label="Menu"
          >
            {mobileMenuOpen ? (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            )}
          </button>
        </div>
        {/* Mobile dropdown — overlay, positioned inside header for top-full */}
        {mobileMenuOpen && (
          <div className="md:hidden absolute top-full left-0 right-0 z-50 bg-terminal-bg shadow-layer-xl rounded-b-2xl border-b border-terminal-border-subtle">
            <div className="px-5 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-sans font-medium text-terminal-dim">Display</span>
                <div className="flex items-center h-8 rounded-lg overflow-hidden bg-terminal-surface">
                  {(["all", "compact", "custom"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => {
                        updatePref("displayMode", mode);
                        if (mode !== "custom") setMobileMenuOpen(false);
                      }}
                      className={`h-full px-3.5 text-xs font-mono capitalize transition-colors ${
                        prefs.displayMode === mode
                          ? "bg-terminal-green-subtle text-terminal-green"
                          : "text-terminal-dim hover:text-terminal-text"
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
              {prefs.displayMode === "custom" && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => togglePref("promptsOnly")}
                    className={`px-3 py-1.5 text-xs font-mono rounded-lg border transition-colors ${
                      prefs.promptsOnly
                        ? "bg-terminal-green-subtle text-terminal-green border-terminal-green/30"
                        : "text-terminal-dim border-terminal-border-subtle"
                    }`}
                  >
                    Prompts Only
                  </button>
                  <button
                    onClick={() => togglePref("collapseAllTools")}
                    className={`px-3 py-1.5 text-xs font-mono rounded-lg border transition-colors ${
                      prefs.collapseAllTools
                        ? "bg-terminal-orange-subtle text-terminal-orange border-terminal-orange/30"
                        : "text-terminal-dim border-terminal-border-subtle"
                    }`}
                  >
                    Tools Collapsed
                  </button>
                  {hasThinking && (
                    <button
                      onClick={() => togglePref("hideThinking")}
                      className={`px-3 py-1.5 text-xs font-mono rounded-lg border transition-colors ${
                        prefs.hideThinking
                          ? "bg-terminal-purple-subtle text-terminal-purple border-terminal-purple/30"
                          : "text-terminal-dim border-terminal-border-subtle"
                      }`}
                    >
                      Thinking Hidden
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-sans font-medium text-terminal-dim">Theme</span>
                <button
                  onClick={() => {
                    toggleTheme();
                    setMobileMenuOpen(false);
                  }}
                  className="h-8 px-3.5 flex items-center gap-2 rounded-lg bg-terminal-surface text-terminal-dim text-xs font-mono transition-colors"
                >
                  {theme === "dark" ? "\u263E" : "\u2600"}
                  <span>{theme === "dark" ? "Light" : "Dark"}</span>
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-sans font-medium text-terminal-dim">GitHub</span>
                <GitHubStarButton />
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Mobile menu backdrop */}
      {mobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/30"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      <Player
        session={session!}
        viewPrefs={prefs}
        viewerMode={viewerMode}
        activeView={activeView}
        setActiveView={handleViewChange}
        returnToLandingRef={returnToLandingRef}
      />
    </div>
  );
}
