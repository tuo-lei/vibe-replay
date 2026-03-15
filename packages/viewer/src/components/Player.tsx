import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnnotations } from "../hooks/useAnnotations";
import { useOverlays } from "../hooks/useOverlays";
import { usePlayback } from "../hooks/usePlayback";
import type { ViewerMode } from "../hooks/useSessionLoader";
import { getEffectivePrefs, type ViewPrefs } from "../hooks/useViewPrefs";
import type { ReplaySession } from "../types";
import AiStudioDrawer from "./AiStudioDrawer";
import CommentDrawer from "./CommentDrawer";
import Controls from "./Controls";
import ConversationView from "./ConversationView";
import ExportView from "./ExportView";
import HelpOverlay from "./HelpOverlay";
import LandingHero from "./LandingHero";
import Minimap from "./Minimap";
import SearchOverlay from "./SearchOverlay";
import { fmtNum, formatDuration, StatCard } from "./StatsPanel";
import SummaryView from "./SummaryView";
import Timeline from "./Timeline";
import ViewTabBar, { type ActiveView } from "./ViewTabBar";

interface Props {
  session: ReplaySession;
  viewPrefs: ViewPrefs;
  viewerMode?: ViewerMode;
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
}

function flashJumpTarget(el: HTMLElement) {
  el.classList.remove("jump-target-flash");
  // Force reflow so repeated clicks on the same target still retrigger animation.
  void el.offsetWidth;
  el.classList.add("jump-target-flash");
  window.setTimeout(() => {
    el.classList.remove("jump-target-flash");
  }, 900);
}

export default function Player({
  session,
  viewPrefs,
  viewerMode = "embedded",
  activeView,
  setActiveView,
}: Props) {
  const isReadOnly = viewerMode === "readonly";
  const [landed, setLanded] = useState(false);
  const [navFocusIndex, setNavFocusIndex] = useState<number | undefined>(undefined);
  const [_navJumpSeq, setNavJumpSeq] = useState(0);
  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  const [studioDrawerOpen, setStudioDrawerOpen] = useState(false);
  const [commentTargetScene, setCommentTargetScene] = useState<number | null>(null);
  const [isOutlineOpen, setIsOutlineOpen] = useState(true);
  const annotationActions = useAnnotations(session, viewerMode);
  const overlayActions = useOverlays(session, viewerMode);
  const { effectiveSession } = overlayActions;
  const { annotations } = annotationActions;

  const effectivePrefs = getEffectivePrefs(viewPrefs);

  const {
    state,
    currentIndex,
    visibleCount,
    speed,
    play,
    pause,
    togglePlayPause,
    seekTo,
    changeSpeed,
    totalScenes,
    userPromptIndices,
    computeNextIndex,
  } = usePlayback(session.scenes, effectivePrefs, landed);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [mobileDrawerTab, setMobileDrawerTab] = useState<"outline" | "stats">("outline");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [_scrollHintDismissed, setScrollHintDismissed] = useState(false);
  const pendingSeekRef = useRef<number | null>(null);
  const navFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flag to suppress auto-scroll when scene advance comes from scroll-to-reveal
  const scrollRevealRef = useRef(false);
  const [showHelp, setShowHelp] = useState(false);

  // Cmd+K / Ctrl+K to open search
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === "/") {
        // Only trigger search if not in an input/textarea
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          setSearchOpen(true);
        }
      } else if (e.key === "?") {
        setShowHelp((v) => !v);
      } else if (e.key === "Escape") {
        if (showHelp) {
          setShowHelp(false);
        } else if (searchOpen) {
          setSearchOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [searchOpen, showHelp]);

  const currentTurn = userPromptIndices.filter((i) => i <= currentIndex).length || 0;
  const userPromptCount = userPromptIndices.length;

  // Find a good initial scene index that fills the viewport
  // (end of first assistant group, or second user prompt, whichever comes first)
  // If ?s=<index> is in the URL, use that for deep-linking to a specific scene.
  const initialSeekIndex = useMemo(() => {
    const urlScene = new URLSearchParams(window.location.search).get("s");
    if (urlScene !== null) {
      const parsed = Number(urlScene);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed < session.scenes.length) {
        return parsed;
      }
    }
    if (userPromptIndices.length >= 2) {
      return userPromptIndices[1];
    }
    // Fallback: show all scenes up to index 15 or total
    return Math.min(15, session.scenes.length - 1);
  }, [userPromptIndices, session.scenes.length]);

  // Start playback when user dismisses landing page
  // autoPlay=true (button click) → play immediately
  // autoPlay=false (scroll/swipe) → show first scene paused, let user control
  const handleStart = useCallback(
    (autoPlay = true) => {
      setLanded(true);
      if (autoPlay) {
        setTimeout(play, 300);
      } else {
        setTimeout(() => seekTo(initialSeekIndex), 100);
      }
    },
    [play, seekTo, initialSeekIndex],
  );

  // Auto-land when user changes display mode from the header while on landing page
  const prevModeRef = useRef(viewPrefs.displayMode);
  useEffect(() => {
    if (prevModeRef.current !== viewPrefs.displayMode) {
      prevModeRef.current = viewPrefs.displayMode;
      if (!landed) {
        setLanded(true);
        setTimeout(() => seekTo(initialSeekIndex), 100);
      }
    }
  }, [viewPrefs.displayMode, landed, seekTo, initialSeekIndex]);

  // Check if URL has ?s= deep-link (used by multiple auto-land effects below)
  const hasUrlScene = useMemo(
    () => new URLSearchParams(window.location.search).get("s") !== null,
    [],
  );

  // Auto-land if we start on a non-replay view (e.g., direct link to insights)
  // Skip if URL has ?s= deep-link — that effect handles its own auto-land
  useEffect(() => {
    if (!landed && activeView !== "replay" && !hasUrlScene) {
      setLanded(true);
      setTimeout(() => seekTo(initialSeekIndex), 100);
    }
  }, [activeView, landed, initialSeekIndex, seekTo, hasUrlScene]);

  const seekFromNavigation = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, session.scenes.length - 1));
      // Manual jumps should pause playback so focus doesn't move away immediately.
      pause();
      pendingSeekRef.current = clamped;
      setNavJumpSeq((n) => n + 1);
      setNavFocusIndex(clamped);
      if (navFocusTimerRef.current) clearTimeout(navFocusTimerRef.current);
      navFocusTimerRef.current = setTimeout(() => setNavFocusIndex(undefined), 2500);
      seekTo(clamped);
      // Scroll + flash is handled by the manual-nav useEffect below (depends on [currentIndex]).
    },
    [pause, seekTo, session.scenes.length],
  );

  // Auto-land if URL has ?s= deep-link (skip landing hero, seek + scroll directly)
  useEffect(() => {
    if (!landed && hasUrlScene) {
      setLanded(true);
      setTimeout(() => seekFromNavigation(initialSeekIndex), 100);
    }
  }, [landed, hasUrlScene, initialSeekIndex, seekFromNavigation]);

  const seekToNextPromptWithFeedback = useCallback(() => {
    const next = userPromptIndices.find((i) => i > currentIndex);
    if (next !== undefined) {
      seekFromNavigation(next);
    }
  }, [userPromptIndices, currentIndex, seekFromNavigation]);

  const seekToPrevPromptWithFeedback = useCallback(() => {
    const prev = [...userPromptIndices].reverse().find((i) => i < currentIndex);
    if (prev !== undefined) {
      seekFromNavigation(prev);
    }
  }, [userPromptIndices, currentIndex, seekFromNavigation]);

  // Track whether auto-scroll is active (programmatic) vs user-initiated
  const programScrollRef = useRef(false);

  // Reset scroll hint when playback resumes
  useEffect(() => {
    if (state === "playing") setScrollHintDismissed(false);
  }, [state]);

  // Auto-scroll to keep the current scene visible.
  // During playback → center the scene. When paused (arrow-key stepping) → ensure
  // the scene is at least visible, scrolling only when it falls outside the viewport.
  useEffect(() => {
    if (!scrollRef.current || currentIndex < 0) return;
    // Skip when a manual navigation (outline/timeline/search) is pending — it
    // has its own scroll handler with flash animation.
    if (pendingSeekRef.current !== null) return;
    // Skip when the advance came from scroll-to-reveal (user is actively scrolling)
    if (scrollRevealRef.current) {
      scrollRevealRef.current = false;
      return;
    }
    const el = scrollRef.current;
    programScrollRef.current = true;
    const getGroupFirstIndex = (idx: number): number => {
      const scenes = session.scenes;
      if (idx < 0 || idx >= scenes.length) return idx;
      if (scenes[idx].type === "user-prompt" || scenes[idx].type === "compaction-summary")
        return idx;
      let first = idx;
      while (
        first > 0 &&
        scenes[first - 1].type !== "user-prompt" &&
        scenes[first - 1].type !== "compaction-summary"
      ) {
        first--;
      }
      return first;
    };

    const findBlockForIndex = (index: number): HTMLElement | null => {
      const exactMatch = el.querySelector(`[data-scene-index="${index}"]`) as HTMLElement | null;
      if (exactMatch) return exactMatch;
      const firstIndex = getGroupFirstIndex(index);
      return el.querySelector(`[data-scene-index="${firstIndex}"]`) as HTMLElement | null;
    };

    requestAnimationFrame(() => {
      const sceneEl = findBlockForIndex(currentIndex);
      if (sceneEl) {
        if (state === "playing") {
          sceneEl.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          // When paused (arrow keys), always bring the new scene into a comfortable
          // reading position (~30% from the top) rather than leaving it at the bottom jump
          const containerRect = el.getBoundingClientRect();
          const sceneRect = sceneEl.getBoundingClientRect();
          const offset = sceneRect.top - containerRect.top + el.scrollTop;
          const target = offset - containerRect.height * 0.3;
          el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        }
      } else if (state === "playing") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
      setTimeout(() => {
        programScrollRef.current = false;
      }, 400);
    });
  }, [currentIndex, state, session.scenes]);

  // User scroll/touch → auto-pause + enter infinite scroll mode
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleUserScroll = () => {
      // Ignore programmatic scrolls
      if (programScrollRef.current) return;
      // Dismiss scroll hint on first user scroll
      setScrollHintDismissed(true);
      // Pause if playing
      if (state === "playing") {
        pause();
      }
    };

    // wheel = mouse/trackpad, touchmove = mobile
    el.addEventListener("wheel", handleUserScroll, { passive: true });
    el.addEventListener("touchmove", handleUserScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", handleUserScroll);
      el.removeEventListener("touchmove", handleUserScroll);
    };
  }, [state, pause]);

  // Scroll-to-reveal: when paused and user scrolls near bottom, advance scenes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let throttle = false;
    const advance = () => {
      if (state !== "paused" || throttle) return;
      if (currentIndex >= session.scenes.length - 1) return;
      // Don't advance during programmatic scrolls or pending navigation jumps.
      if (programScrollRef.current || pendingSeekRef.current !== null) return;

      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        throttle = true;
        scrollRevealRef.current = true;
        // Instead of blind + 1, jump to the next visual breakpoint for current mode
        const nextIdx = computeNextIndex(currentIndex);
        if (nextIdx !== -1) seekTo(nextIdx);
        setTimeout(() => {
          throttle = false;
        }, 150);
      }
    };

    // wheel covers the case where content is shorter than viewport (no scroll events fire)
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) advance();
    };

    // Touch gesture for scroll-to-reveal when content is shorter than viewport
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      const deltaY = touchStartY - e.changedTouches[0].clientY;
      if (deltaY > 20) advance();
    };

    el.addEventListener("scroll", advance, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("scroll", advance);
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, [state, currentIndex, session.scenes.length, seekTo, computeNextIndex]);

  // Manual navigation (outline/timeline/search): always center + flash the target scene.
  useEffect(() => {
    const targetIndex = pendingSeekRef.current;
    const el = scrollRef.current;
    if (targetIndex === null || !el || currentIndex !== targetIndex) return;

    let cancelled = false;
    let attempts = 0;

    const findBlockForIndex = (index: number): HTMLElement | null => {
      // First try an exact match (if it's rendered, e.g. in 'all' mode or batched expanded)
      const elMatch = el.querySelector(`[data-scene-index="${index}"]`) as HTMLElement | null;
      if (elMatch) return elMatch;

      // In compact mode, the precise scene might not be rendered individually.
      // E.g. a compaction block has first index 44, but contains 44-50.
      // We find the nearest [data-scene-index] that is <= our targetIndex.
      const blocks = Array.from(el.querySelectorAll("[data-scene-index]")) as HTMLElement[];
      let bestMatch: HTMLElement | null = null;
      let bestDiff = Infinity;

      for (const block of blocks) {
        const idxStr = block.getAttribute("data-scene-index");
        if (!idxStr) continue;
        const blockIdx = parseInt(idxStr, 10);
        if (blockIdx <= index) {
          const diff = index - blockIdx;
          if (diff < bestDiff) {
            bestDiff = diff;
            bestMatch = block;
          }
        }
      }
      return bestMatch;
    };

    const tryLocateAndFocus = () => {
      if (cancelled) return;
      const sceneEl = findBlockForIndex(targetIndex);
      if (sceneEl) {
        programScrollRef.current = true;
        // Manual center: place top of target at ~30% from viewport top
        const containerRect = el.getBoundingClientRect();
        const sceneRect = sceneEl.getBoundingClientRect();
        const offset = sceneRect.top - containerRect.top + el.scrollTop;
        const target = offset - containerRect.height * 0.3;
        el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        flashJumpTarget(sceneEl);
        setTimeout(() => {
          programScrollRef.current = false;
        }, 450);
        pendingSeekRef.current = null;
        return;
      }

      attempts += 1;
      if (attempts < 30) {
        setTimeout(tryLocateAndFocus, 80);
      } else {
        pendingSeekRef.current = null;
      }
    };

    requestAnimationFrame(tryLocateAndFocus);
    return () => {
      cancelled = true;
    };
  }, [currentIndex]);

  useEffect(() => {
    return () => {
      if (navFocusTimerRef.current) clearTimeout(navFocusTimerRef.current);
    };
  }, []);

  // Sync currentIndex → URL ?s= param (debounced to avoid noise during playback)
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentIndex < 0 || !landed) return;
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    const delay = state === "playing" ? 500 : 0;
    urlSyncTimer.current = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("s", String(currentIndex));
      window.history.replaceState({}, "", url.toString());
    }, delay);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [currentIndex, state, landed]);

  const hasAiStudio = viewerMode === "editor";
  const hasAiFeedback = useMemo(
    () => annotations.some((a) => a.author === "vibe-feedback"),
    [annotations],
  );

  // Show landing page before playback starts, but only if we are in the replay view
  if (!landed && activeView === "replay") {
    return <LandingHero session={effectiveSession} onStart={handleStart} />;
  }

  const { meta } = session;

  return (
    <div className="flex flex-1 min-h-0 relative">
      {/* Main content area */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {/* View Tab Bar with embedded global CTAs */}
        <ViewTabBar
          activeView={activeView}
          onChangeView={setActiveView}
          hiddenTabs={isReadOnly ? ["export"] : undefined}
          rightContent={
            activeView === "replay" ? (
              <div className="flex items-center gap-3">
                {/* Global overlay toggle — iOS pill style */}
                {overlayActions.overlayCount > 0 && (
                  <button
                    onClick={() => overlayActions.toggleAllOriginals()}
                    className="flex items-center gap-2 text-xs font-mono text-terminal-dim"
                    title={
                      overlayActions.showAllOriginals
                        ? "Showing originals — click to show modified"
                        : "Showing modified — click to show originals"
                    }
                  >
                    <span className="hidden sm:inline">
                      {overlayActions.showAllOriginals ? "Original" : "Modified"}
                    </span>
                    <span
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ${
                        overlayActions.showAllOriginals
                          ? "bg-terminal-surface border border-terminal-border"
                          : "bg-terminal-purple brightness-75"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                          overlayActions.showAllOriginals
                            ? "translate-x-[3px]"
                            : "translate-x-[17px]"
                        }`}
                      />
                    </span>
                  </button>
                )}

                {/* Comments */}
                <button
                  onClick={() => setCommentDrawerOpen(true)}
                  className="flex items-center gap-1.5 text-xs font-mono font-semibold text-terminal-text hover:text-terminal-green transition-colors"
                  title="Open comments"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-terminal-dim"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>
                  <span className="hidden sm:inline">Comments</span>
                  {annotationActions.annotations.length > 0 && (
                    <span className="ml-0.5 px-1 py-0.5 rounded bg-terminal-black text-[10px] text-terminal-text border border-terminal-border tabular-nums leading-none">
                      {annotationActions.annotations.length}
                    </span>
                  )}
                </button>

                {/* AI Studio button */}
                {hasAiStudio && (
                  <button
                    onClick={() => setStudioDrawerOpen(true)}
                    className="pl-2 pr-3 py-1 text-[10px] sm:text-[11px] font-mono rounded bg-[rgba(168,85,247,0.1)] hover:bg-[rgba(168,85,247,0.2)] border border-[rgba(168,85,247,0.3)] hover:border-[rgba(168,85,247,0.5)] text-terminal-purple transition-all flex items-center gap-1.5 relative overflow-hidden group shadow-sm"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-[#c084fc]"
                    >
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                    </svg>
                    <span className="font-semibold tracking-wide">AI Studio</span>
                    {(hasAiFeedback || overlayActions.overlayCount > 0) && (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminal-purple opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-terminal-purple" />
                      </span>
                    )}
                  </button>
                )}
              </div>
            ) : undefined
          }
        />

        {/* Active view content */}
        <div className="flex flex-1 min-h-0 min-w-0 w-full">
          {activeView === "replay" && (
            <div className="flex flex-1 min-h-0 min-w-0 w-full relative">
              {/* Left Sidebar — stacked Outline + compact Stats */}
              {isOutlineOpen && (
                <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-bg shadow-layer-sm">
                  {/* Outline (top, scrollable) */}
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {/* Sidebar Header */}
                    <div className="px-3 py-2 border-b border-terminal-border-subtle flex items-center justify-between group/side">
                      <span className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest">
                        Outline
                      </span>
                      <button
                        onClick={() => setIsOutlineOpen(false)}
                        className="p-1 rounded hover:bg-terminal-surface text-terminal-dimmer hover:text-terminal-text transition-colors"
                        title="Hide Sidebar"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                          <line x1="9" x2="9" y1="3" y2="21" />
                        </svg>
                      </button>
                    </div>
                    <Minimap
                      scenes={session.scenes}
                      currentIndex={currentIndex}
                      onSeek={seekFromNavigation}
                      overlayActions={overlayActions}
                    />
                  </div>
                  {/* Compact Stats (bottom) */}
                  <div className="shrink-0 border-t border-terminal-border-subtle overflow-y-auto max-h-[35%]">
                    <div className="px-3 py-2 border-b border-terminal-border-subtle">
                      <button
                        onClick={() => setActiveView("summary")}
                        className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest hover:text-terminal-green transition-colors"
                        title="Open Insights view"
                      >
                        Stats
                      </button>
                    </div>
                    <div className="p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <StatCard
                          label="Turns"
                          value={meta.stats.userPrompts}
                          color="text-terminal-green"
                        />
                        <StatCard
                          label="Tools"
                          value={meta.stats.toolCalls}
                          color="text-terminal-orange"
                        />
                      </div>
                      <div className="mt-2 text-xs font-mono text-terminal-dim space-y-0.5">
                        {meta.model && (
                          <div>
                            <span className="text-terminal-text">{meta.model}</span>
                          </div>
                        )}
                        {meta.stats.durationMs && (
                          <div>
                            {formatDuration(meta.stats.durationMs)}
                            {meta.stats.costEstimate !== undefined && (
                              <span>
                                {" / "}
                                <span className="text-terminal-green">
                                  $
                                  {meta.stats.costEstimate < 0.01
                                    ? meta.stats.costEstimate.toFixed(4)
                                    : meta.stats.costEstimate.toFixed(2)}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                        {meta.stats.tokenUsage && (
                          <div>
                            {fmtNum(meta.stats.tokenUsage.inputTokens)} in /{" "}
                            {fmtNum(meta.stats.tokenUsage.outputTokens)} out
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Main Replay list area */}
              <div className="flex flex-col flex-1 min-h-0 min-w-0 relative">
                {/* Floating Expand Button (shown when sidebar is closed) */}
                {!isOutlineOpen && (
                  <button
                    onClick={() => setIsOutlineOpen(true)}
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-20 group/expand px-1.5 py-4 bg-terminal-surface/80 backdrop-blur-md border border-l-0 border-terminal-border-subtle rounded-r-xl text-terminal-dim hover:text-terminal-green transition-all shadow-layer-md animate-in slide-in-from-left-2 duration-300"
                    title="Show Sidebar"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
                <div
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto px-5 py-5 pb-10 overscroll-contain"
                >
                  <ConversationView
                    scenes={session.scenes}
                    visibleCount={visibleCount}
                    currentIndex={currentIndex}
                    effectivePrefs={effectivePrefs}
                    focusIndex={navFocusIndex}
                    annotatedScenes={annotationActions.annotatedScenes}
                    annotationCounts={annotationActions.annotationCounts}
                    onSeek={seekFromNavigation}
                    state={state}
                    overlayActions={overlayActions}
                    onComment={
                      isReadOnly
                        ? undefined
                        : (sceneIndex) => {
                            setCommentDrawerOpen(true);
                            setCommentTargetScene(sceneIndex);
                          }
                    }
                  />
                </div>

                {/* Search overlay */}
                <SearchOverlay
                  scenes={effectiveSession.scenes}
                  open={searchOpen}
                  onClose={() => setSearchOpen(false)}
                  onSeek={(i) => {
                    seekFromNavigation(i);
                    setSearchOpen(false);
                  }}
                />
              </div>
            </div>
          )}

          {activeView === "summary" && <SummaryView session={effectiveSession} />}
          {activeView === "export" && (
            <ExportView
              actions={annotationActions}
              viewerMode={viewerMode}
              readOnly={isReadOnly}
              session={effectiveSession}
            />
          )}
        </div>

        {/* Playback bar — only in replay view */}
        {activeView === "replay" && (
          <div className="shrink-0 border-t border-terminal-border-subtle bg-terminal-surface/80 backdrop-blur-md sticky bottom-0 safe-bottom shadow-layer-lg">
            <Timeline
              scenes={session.scenes}
              currentIndex={currentIndex}
              onSeek={seekFromNavigation}
              annotatedScenes={annotationActions.annotatedScenes}
            />
            <Controls
              state={state}
              speed={speed}
              currentIndex={currentIndex}
              totalScenes={totalScenes}
              userPromptCount={userPromptCount}
              currentTurn={currentTurn}
              onTogglePlayPause={togglePlayPause}
              onChangeSpeed={changeSpeed}
              onPrevPrompt={seekToPrevPromptWithFeedback}
              onNextPrompt={seekToNextPromptWithFeedback}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenOutline={() => setMobileDrawerOpen(true)}
              onShowHelp={() => setShowHelp(true)}
            />
          </div>
        )}
      </div>

      {/* Comment drawer (slides from right) */}
      <CommentDrawer
        open={commentDrawerOpen}
        onClose={() => setCommentDrawerOpen(false)}
        actions={annotationActions}
        scenes={effectiveSession.scenes}
        currentIndex={currentIndex}
        onSeek={seekFromNavigation}
        addingForScene={commentTargetScene}
        onClearAddingTarget={() => setCommentTargetScene(null)}
        readOnly={isReadOnly}
      />

      {/* AI Studio drawer (slides from right) */}
      <AiStudioDrawer
        open={studioDrawerOpen}
        onClose={() => setStudioDrawerOpen(false)}
        annotationActions={annotationActions}
        overlayActions={overlayActions}
      />

      {/* Mobile sidebar drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-opacity duration-300 ${
          mobileDrawerOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setMobileDrawerOpen(false)}
      >
        <div className="absolute inset-0 bg-black/40" />
        <div
          className={`absolute bottom-0 left-0 right-0 h-[65vh] bg-terminal-bg border-t border-terminal-border-subtle rounded-t-2xl flex flex-col transition-transform duration-300 ease-material-decel safe-bottom shadow-layer-xl ${
            mobileDrawerOpen ? "translate-y-0" : "translate-y-full"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle */}
          <div className="flex justify-center py-2.5 shrink-0">
            <div className="w-10 h-1 rounded-full bg-terminal-border" />
          </div>
          {/* Tabs */}
          <div className="flex border-b border-terminal-border-subtle shrink-0">
            <button
              onClick={() => setMobileDrawerTab("outline")}
              className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
                mobileDrawerTab === "outline"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Outline
            </button>
            <button
              onClick={() => setMobileDrawerTab("stats")}
              className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
                mobileDrawerTab === "stats"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Stats
            </button>
          </div>
          {/* Content */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {mobileDrawerTab === "outline" ? (
              <Minimap
                scenes={session.scenes}
                currentIndex={currentIndex}
                onSeek={(i) => {
                  seekFromNavigation(i);
                  setMobileDrawerOpen(false);
                }}
                overlayActions={overlayActions}
              />
            ) : (
              <SummaryView session={effectiveSession} />
            )}
          </div>
        </div>
      </div>

      <HelpOverlay open={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
