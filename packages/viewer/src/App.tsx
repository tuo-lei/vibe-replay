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

const CLOUD_API = __CLOUD_API_URL__;

function DashboardAuthStatus({ isEditor }: { isEditor: boolean }) {
  const [auth, setAuth] = useState<{
    authenticated: boolean;
    user: { name?: string; image?: string } | null;
  } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const authPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sessionUrl = isEditor ? "/api/auth/get-session" : `${CLOUD_API}/api/auth/get-session`;
    let signInOrigin = "";
    if (!isEditor) {
      try {
        signInOrigin = new URL(CLOUD_API).origin;
      } catch {
        signInOrigin = "";
      }
    }
    const authFetchInit = isEditor ? {} : { credentials: "include" as const };
    const check = () => {
      fetch(sessionUrl, authFetchInit)
        .then((r) => r.json())
        .then((data: any) => {
          if (data?.session) {
            setAuth({ authenticated: true, user: data.user || null });
          } else {
            setAuth({ authenticated: false, user: null });
          }
        })
        .catch(() => setAuth({ authenticated: false, user: null }));
    };
    check();
    // Listen for postMessage from OAuth success page (cloud auth flow only)
    const onMessage = (e: MessageEvent) => {
      if (
        !isEditor &&
        e.origin === signInOrigin &&
        e.data?.type === "vibe-replay-auth" &&
        e.data.user
      ) {
        setAuth({ authenticated: true, user: e.data.user });
        window.dispatchEvent(new Event("vibe-auth-change"));
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", check);
    return () => {
      if (authPollIntervalRef.current) {
        clearInterval(authPollIntervalRef.current);
        authPollIntervalRef.current = null;
      }
      if (authPollTimeoutRef.current) {
        clearTimeout(authPollTimeoutRef.current);
        authPollTimeoutRef.current = null;
      }
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", check);
    };
  }, [isEditor]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [dropdownOpen]);

  if (!auth) return null;

  if (!auth.authenticated) {
    return (
      <button
        type="button"
        onClick={async () => {
          if (isEditor) {
            try {
              const res = await fetch("/api/auth/login", { method: "POST" });
              const data = await res.json().catch(() => null);
              if (res.ok && data?.url) {
                window.open(data.url, "_blank");
              }
            } catch {
              // Keep UI unchanged; poll below may still recover.
            }
          } else {
            window.open(`${CLOUD_API}/auth/login?callback=/auth/success`, "_blank");
          }

          if (authPollIntervalRef.current) {
            clearInterval(authPollIntervalRef.current);
            authPollIntervalRef.current = null;
          }
          if (authPollTimeoutRef.current) {
            clearTimeout(authPollTimeoutRef.current);
            authPollTimeoutRef.current = null;
          }

          const sessionUrl = isEditor
            ? "/api/auth/get-session"
            : `${CLOUD_API}/api/auth/get-session`;
          const authFetchInit = isEditor ? {} : { credentials: "include" as const };
          authPollIntervalRef.current = setInterval(async () => {
            try {
              const r = await fetch(sessionUrl, authFetchInit);
              const s = await r.json();
              if (s?.session) {
                if (authPollIntervalRef.current) {
                  clearInterval(authPollIntervalRef.current);
                  authPollIntervalRef.current = null;
                }
                if (authPollTimeoutRef.current) {
                  clearTimeout(authPollTimeoutRef.current);
                  authPollTimeoutRef.current = null;
                }
                setAuth({ authenticated: true, user: s.user || null });
                window.dispatchEvent(new Event("vibe-auth-change"));
              }
            } catch {}
          }, 2000);
          authPollTimeoutRef.current = setTimeout(
            () => {
              if (authPollIntervalRef.current) {
                clearInterval(authPollIntervalRef.current);
                authPollIntervalRef.current = null;
              }
              authPollTimeoutRef.current = null;
            },
            5 * 60 * 1000,
          );
        }}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[#24292f] hover:bg-[#32383f] text-white text-xs font-medium transition-colors cursor-pointer border border-white/10"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
        Sign in
      </button>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center justify-center w-7 h-7 rounded-full ring-2 ring-terminal-border/40 hover:ring-terminal-green/60 transition-all cursor-pointer overflow-hidden"
      >
        {auth.user?.image ? (
          <img src={auth.user.image} alt="" className="w-full h-full rounded-full object-cover" />
        ) : (
          <span className="text-[10px] text-terminal-dim">?</span>
        )}
      </button>
      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-2 min-w-[140px] bg-terminal-surface border border-terminal-border rounded-lg shadow-lg py-1 z-50">
          <div className="px-3 py-2 text-[11px] text-terminal-dim border-b border-terminal-border truncate font-mono">
            {auth.user?.name || "logged in"}
          </div>
          <button
            type="button"
            onClick={async () => {
              const signOutUrl = isEditor ? "/api/auth/sign-out" : `${CLOUD_API}/api/auth/sign-out`;
              await fetch(signOutUrl, {
                method: "POST",
                ...(isEditor ? {} : { credentials: "include" }),
              });
              window.location.reload();
            }}
            className="w-full text-left px-3 py-2 text-xs text-terminal-dim hover:text-red-400 hover:bg-terminal-surface-hover transition-colors cursor-pointer font-mono"
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}

function GitHubStarButton() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    // Only fetch star count in editor/dashboard mode — self-contained HTML
    // must make zero external requests (see CLAUDE.md)
    if (!window.__VIBE_REPLAY_EDITOR__) return;
    fetch("https://api.github.com/repos/tuo-lei/vibe-replay")
      .then((r) => r.json())
      .then((d) => {
        if (d.stargazers_count != null) setCount(d.stargazers_count);
      })
      .catch(() => {});
  }, []);
  return (
    <a
      href="https://github.com/tuo-lei/vibe-replay"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center h-7 rounded-md border border-terminal-border text-xs font-medium text-terminal-text/70 hover:text-terminal-text hover:border-terminal-text/30 transition-colors"
    >
      <span className="inline-flex items-center gap-1 px-2">
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z" />
        </svg>
        Star
      </span>
      {count != null && (
        <span className="inline-flex items-center px-2 h-full border-l border-terminal-border">
          {count}
        </span>
      )}
    </a>
  );
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
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mobileMenuOpen]);
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
        <Dashboard
          headerLeft={
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                onClick={() => navigateTo({ view: null, session: null })}
                className="text-sm font-sans font-bold bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent hover:opacity-80 transition-opacity"
              >
                vibe-replay
              </button>
              <span className="instant-tooltip inline-flex items-center gap-1 text-[9px] font-sans font-bold px-2 py-0.5 rounded-full bg-terminal-green/10 text-terminal-green uppercase tracking-wider border border-terminal-green/20">
                <span className="w-1 h-1 rounded-full bg-terminal-green animate-pulse" />
                Local
                <span className="instant-tooltip-text">
                  {`v${__CLI_VERSION__}\nViewer ${window.location.host}${import.meta.env.VITE_API_PORT ? `\nCLI :${import.meta.env.VITE_API_PORT}` : ""}${__CLOUD_API_URL__ ? `\nCloud ${__CLOUD_API_URL__}` : ""}`}
                </span>
              </span>
            </div>
          }
          headerRight={
            <div className="flex items-center gap-2 shrink-0">
              <GitHubStarButton />
              <button
                onClick={toggleTheme}
                className="w-7 h-7 flex items-center justify-center rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover text-sm transition-colors"
              >
                {theme === "dark" ? "\u263E" : "\u2600"}
              </button>
              <DashboardAuthStatus isEditor={true} />
            </div>
          }
        />
      </div>
    );
  }

  const { meta } = session!;
  return (
    <div className="h-screen bg-terminal-bg flex flex-col overflow-hidden">
      <header className="relative z-40 border-b border-terminal-border-subtle px-5 py-2 flex items-center gap-4 shrink-0 glass-effect safe-top">
        {/* Left: branding */}
        <div className="flex items-center gap-2.5 shrink-0">
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
            <span className="instant-tooltip inline-flex items-center gap-1 text-[9px] font-sans font-bold px-2 py-0.5 rounded-full bg-terminal-green/10 text-terminal-green uppercase tracking-wider border border-terminal-green/20">
              <span className="w-1 h-1 rounded-full bg-terminal-green animate-pulse" />
              Local
              <span className="instant-tooltip-text">
                {`v${__CLI_VERSION__}\nViewer ${window.location.host}${import.meta.env.VITE_API_PORT ? `\nCLI :${import.meta.env.VITE_API_PORT}` : ""}${__CLOUD_API_URL__ ? `\nCloud ${__CLOUD_API_URL__}` : ""}`}
              </span>
            </span>
          )}
        </div>

        {/* Tabs (editor) */}
        {isEditor && (
          <nav className="hidden md:inline-flex items-center rounded-xl bg-terminal-surface p-0.5 shadow-layer-sm shrink-0">
            {(["home", "sessions", "replays", "projects", "insights"] as const).map((t) => (
              <button
                key={t}
                onClick={() => navigateTo({ view: "dashboard", session: null, tab: t })}
                className="px-3.5 py-1.5 text-xs font-sans font-semibold rounded-lg text-terminal-dim hover:text-terminal-text transition-all duration-200 ease-material"
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
        )}
        {/* Session title */}
        {meta.title && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-terminal-border/40 text-sm select-none hidden md:inline">|</span>
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
        )}
        <div className="flex-1" />

        <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
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

            {isEditor && <DashboardAuthStatus isEditor={isEditor} />}
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
