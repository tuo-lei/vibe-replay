import { useCallback, useEffect, useRef, useState } from "react";
import { useAnnotations } from "../hooks/useAnnotations";
import { usePlayback } from "../hooks/usePlayback";
import type { ViewerMode } from "../hooks/useSessionLoader";
import { getEffectivePrefs, type ViewPrefs } from "../hooks/useViewPrefs";
import type { ReplaySession } from "../types";
import AnnotationPanel from "./AnnotationPanel";
import Controls from "./Controls";
import ConversationView from "./ConversationView";
import LandingHero from "./LandingHero";
import Minimap from "./Minimap";
import SearchOverlay from "./SearchOverlay";
import StatsPanel from "./StatsPanel";
import Timeline from "./Timeline";

interface Props {
  session: ReplaySession;
  viewPrefs: ViewPrefs;
  viewerMode?: ViewerMode;
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

export default function Player({ session, viewPrefs, viewerMode = "embedded" }: Props) {
  const isReadOnly = viewerMode === "readonly";
  const [landed, setLanded] = useState(false);
  const [navFocusIndex, setNavFocusIndex] = useState<number | undefined>(undefined);
  const [_navJumpSeq, setNavJumpSeq] = useState(0);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(() => {
    // Check embedded annotations
    if ((session.annotations?.length ?? 0) > 0) return true;
    // Check localStorage draft (useAnnotations loads from here too)
    try {
      const key = `vibe-replay-annotations-${session.meta.sessionId}`;
      const draft = localStorage.getItem(key);
      if (draft) {
        const parsed = JSON.parse(draft);
        return Array.isArray(parsed) && parsed.length > 0;
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  const [commentTargetScene, setCommentTargetScene] = useState<number | null>(null);
  const annotationActions = useAnnotations(session, viewerMode);

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
  } = usePlayback(session.scenes, effectivePrefs.promptsOnly, landed);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarTab, setSidebarTab] = useState<"outline" | "stats" | "comments">("outline");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [scrollHintDismissed, setScrollHintDismissed] = useState(false);
  const pendingSeekRef = useRef<number | null>(null);
  const navFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flag to suppress auto-scroll when scene advance comes from scroll-to-reveal
  const scrollRevealRef = useRef(false);

  // Cmd+K / Ctrl+K to open search
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const currentTurn = userPromptIndices.filter((i) => i <= currentIndex).length || 0;
  const userPromptCount = userPromptIndices.length;

  // Find a good initial scene index that fills the viewport
  // (end of first assistant group, or second user prompt, whichever comes first)
  const initialSeekIndex = useMemo(() => {
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
    },
    [pause, seekTo, session.scenes.length],
  );

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
    requestAnimationFrame(() => {
      const sceneEl = el.querySelector(`[data-scene-index="${currentIndex}"]`);
      if (sceneEl) {
        if (state === "playing") {
          sceneEl.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          // When paused (arrow keys), keep the scene comfortably in view.
          // "nearest" only scrolls if the element is outside the visible area,
          // but it pins to the very edge. Instead, manually check and place the
          // scene at ~30% from the top when it would go below the viewport.
          const containerRect = el.getBoundingClientRect();
          const sceneRect = sceneEl.getBoundingClientRect();
          const relativeTop = sceneRect.top - containerRect.top;
          const relativeBottom = sceneRect.bottom - containerRect.top;

          if (relativeBottom > containerRect.height || relativeTop < 0) {
            // Scene is out of view — scroll so its top sits at ~30% from viewport top
            const offset = sceneRect.top - containerRect.top + el.scrollTop;
            const target = offset - containerRect.height * 0.3;
            el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
          }
        }
      } else if (state === "playing") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
      setTimeout(() => {
        programScrollRef.current = false;
      }, 400);
    });
  }, [currentIndex, state]);

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
      // pendingSeekRef is critical: when seekFromNavigation shrinks visibleCount,
      // the DOM shrinks and fires scroll events BEFORE effects set programScrollRef.
      if (programScrollRef.current || pendingSeekRef.current !== null) return;

      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        throttle = true;
        scrollRevealRef.current = true;
        seekTo(currentIndex + 1);
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
  }, [state, currentIndex, session.scenes.length, seekTo]);

  // Manual navigation (outline/timeline/search): always center + flash the target scene.
  useEffect(() => {
    const targetIndex = pendingSeekRef.current;
    const el = scrollRef.current;
    if (targetIndex === null || !el || currentIndex !== targetIndex) return;

    let cancelled = false;
    let attempts = 0;
    const tryLocateAndFocus = () => {
      if (cancelled) return;
      const sceneEl = el.querySelector(`[data-scene-index="${targetIndex}"]`) as HTMLElement | null;
      if (sceneEl) {
        programScrollRef.current = true;
        // Manual center: place top of target at ~35% from viewport top
        // (slightly above center feels more natural for reading)
        const containerRect = el.getBoundingClientRect();
        const sceneRect = sceneEl.getBoundingClientRect();
        const offset = sceneRect.top - containerRect.top + el.scrollTop;
        const target = offset - containerRect.height * 0.35;
        el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        flashJumpTarget(sceneEl);
        setTimeout(() => {
          programScrollRef.current = false;
        }, 450);
        pendingSeekRef.current = null;
        return;
      }

      attempts += 1;
      if (attempts < 12) {
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

  // Show landing page before playback starts
  if (!landed) {
    return <LandingHero session={session} onStart={handleStart} />;
  }

  return (
    <div className="flex flex-1 min-h-0 relative">
      {/* Sidebar */}
      <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-bg shadow-layer-sm">
        <div className="flex border-b border-terminal-border-subtle">
          <button
            onClick={() => setSidebarTab("outline")}
            className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
              sidebarTab === "outline"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
            }`}
          >
            Outline
          </button>
          <button
            onClick={() => setSidebarTab("stats")}
            className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
              sidebarTab === "stats"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
            }`}
          >
            Stats
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sidebarTab === "stats" ? (
            <StatsPanel session={session} />
          ) : (
            <Minimap
              scenes={session.scenes}
              currentIndex={currentIndex}
              onSeek={seekFromNavigation}
            />
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col flex-1 min-h-0 min-w-0 relative">
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
                onComment={
                  isReadOnly
                    ? undefined
                    : (sceneIndex) => {
                        setAnnotationPanelOpen(true);
                        setCommentTargetScene(sceneIndex);
                      }
                }
              />
            </div>

            {/* Scroll-to-reveal hint */}
            {state === "paused" &&
              currentIndex < session.scenes.length - 1 &&
              !scrollHintDismissed && (
                <div className="absolute bottom-[72px] left-1/2 -translate-x-1/2 z-10 pointer-events-none animate-bounce">
                  <div className="px-5 py-2 rounded-full bg-terminal-surface/90 backdrop-blur-md text-xs font-mono text-terminal-dim flex items-center gap-2 shadow-layer-lg border border-terminal-border-subtle">
                    <span className="text-terminal-green">{"\u2193"}</span>
                    scroll for more
                  </div>
                </div>
              )}

            {/* Search overlay */}
            <SearchOverlay
              scenes={session.scenes}
              open={searchOpen}
              onClose={() => setSearchOpen(false)}
              onSeek={(i) => {
                seekFromNavigation(i);
                setSearchOpen(false);
              }}
            />

            {/* Pause overlay — hidden on mobile (shown in controls bar instead) */}
            {state === "paused" && visibleCount > 0 && (
              <div className="hidden md:block absolute top-3 right-3 px-3.5 py-1.5 rounded-lg bg-terminal-orange-subtle text-terminal-orange text-[10px] font-sans font-semibold uppercase tracking-widest pause-overlay pointer-events-none backdrop-blur-sm">
                PAUSED
              </div>
            )}
          </div>

          {/* Annotation panel — right sidebar */}
          {annotationPanelOpen && (
            <div className="hidden md:flex w-72 shrink-0 flex-col border-l border-terminal-border-subtle bg-terminal-bg">
              <AnnotationPanel
                actions={annotationActions}
                scenes={session.scenes}
                currentIndex={currentIndex}
                totalScenes={totalScenes}
                onSeek={seekFromNavigation}
                addingForScene={commentTargetScene}
                onClearAddingTarget={() => setCommentTargetScene(null)}
                readOnly={isReadOnly}
              />
            </div>
          )}
        </div>

        {/* Playback bar */}
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
            annotationCount={annotationActions.annotations.length}
            annotationPanelOpen={annotationPanelOpen}
            onToggleAnnotations={() => setAnnotationPanelOpen((v) => !v)}
            hasUnsavedAnnotations={annotationActions.hasUnsaved}
          />
        </div>
      </div>

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
              onClick={() => setSidebarTab("outline")}
              className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
                sidebarTab === "outline"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Outline
            </button>
            <button
              onClick={() => setSidebarTab("stats")}
              className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
                sidebarTab === "stats"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Stats
            </button>
            <button
              onClick={() => setSidebarTab("comments")}
              className={`flex-1 px-3 py-2.5 text-[10px] font-sans font-semibold uppercase tracking-widest transition-colors ${
                sidebarTab === "comments"
                  ? "text-terminal-blue border-b-2 border-terminal-blue"
                  : "text-terminal-dim hover:text-terminal-text"
              }`}
            >
              Comments
              {annotationActions.annotations.length > 0
                ? ` (${annotationActions.annotations.length})`
                : ""}
            </button>
          </div>
          {/* Content */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {sidebarTab === "outline" ? (
              <Minimap
                scenes={session.scenes}
                currentIndex={currentIndex}
                onSeek={(i) => {
                  seekFromNavigation(i);
                  setMobileDrawerOpen(false);
                }}
              />
            ) : sidebarTab === "stats" ? (
              <StatsPanel session={session} />
            ) : (
              <AnnotationPanel
                actions={annotationActions}
                scenes={session.scenes}
                currentIndex={currentIndex}
                totalScenes={totalScenes}
                onSeek={(i) => {
                  seekFromNavigation(i);
                  setMobileDrawerOpen(false);
                }}
                addingForScene={commentTargetScene}
                onClearAddingTarget={() => setCommentTargetScene(null)}
                readOnly={isReadOnly}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
