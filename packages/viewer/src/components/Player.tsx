import { useRef, useEffect, useState, useCallback } from "react";
import type { ReplaySession } from "../types";
import type { ViewPrefs } from "../hooks/useViewPrefs";
import { usePlayback } from "../hooks/usePlayback";
import Timeline from "./Timeline";
import Controls from "./Controls";
import ConversationView from "./ConversationView";
import Minimap from "./Minimap";
import StatsPanel from "./StatsPanel";
import SearchOverlay from "./SearchOverlay";
import LandingHero from "./LandingHero";

interface Props {
  session: ReplaySession;
  viewPrefs: ViewPrefs;
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

export default function Player({ session, viewPrefs }: Props) {
  const [landed, setLanded] = useState(false);
  const [navFocusIndex, setNavFocusIndex] = useState<number | undefined>(undefined);
  const [navJumpSeq, setNavJumpSeq] = useState(0);

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
  } = usePlayback(session.scenes, viewPrefs.promptsOnly, landed);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarTab, setSidebarTab] = useState<"outline" | "stats">("outline");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [scrollHintDismissed, setScrollHintDismissed] = useState(false);
  const pendingSeekRef = useRef<number | null>(null);
  const navFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const currentTurn =
    userPromptIndices.filter((i) => i <= currentIndex).length || 0;
  const userPromptCount = userPromptIndices.length;

  // Start playback when user dismisses landing page
  // autoPlay=true (button click) → play immediately
  // autoPlay=false (scroll/swipe) → show first scene paused, let user control
  const handleStart = useCallback((autoPlay = true) => {
    setLanded(true);
    if (autoPlay) {
      setTimeout(play, 300);
    } else {
      setTimeout(() => seekTo(0), 100);
    }
  }, [play, seekTo]);

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

  // Auto-scroll to current scene — only during playback
  useEffect(() => {
    if (!scrollRef.current || currentIndex < 0 || state !== "playing") return;
    const el = scrollRef.current;
    programScrollRef.current = true;
    requestAnimationFrame(() => {
      const sceneEl = el.querySelector(`[data-scene-index="${currentIndex}"]`);
      if (sceneEl) {
        sceneEl.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
      // Clear flag after smooth scroll settles
      setTimeout(() => { programScrollRef.current = false; }, 400);
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

      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        throttle = true;
        seekTo(currentIndex + 1);
        setTimeout(() => { throttle = false; }, 150);
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
      const sceneEl = el.querySelector(
        `[data-scene-index="${targetIndex}"]`,
      ) as HTMLElement | null;
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
        setTimeout(() => { programScrollRef.current = false; }, 450);
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
  }, [navJumpSeq, currentIndex, visibleCount]);

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
      <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-terminal-border/50 bg-terminal-bg">
        <div className="flex border-b border-terminal-border/50">
          <button
            onClick={() => setSidebarTab("outline")}
            className={`flex-1 px-3 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
              sidebarTab === "outline"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text"
            }`}
          >
            Outline
          </button>
          <button
            onClick={() => setSidebarTab("stats")}
            className={`flex-1 px-3 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
              sidebarTab === "stats"
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-dim hover:text-terminal-text"
            }`}
          >
            Stats
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sidebarTab === "outline" ? (
            <Minimap
              scenes={session.scenes}
              currentIndex={currentIndex}
              onSeek={seekFromNavigation}
            />
          ) : (
            <StatsPanel session={session} />
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 pb-8 overscroll-contain">
          <ConversationView
            scenes={session.scenes}
            visibleCount={visibleCount}
            currentIndex={currentIndex}
            viewPrefs={viewPrefs}
            focusIndex={navFocusIndex}
          />
        </div>

        {/* Scroll-to-reveal hint */}
        {state === "paused" && currentIndex < session.scenes.length - 1 && !scrollHintDismissed && (
          <div className="absolute bottom-[72px] left-1/2 -translate-x-1/2 z-10 pointer-events-none animate-bounce">
            <div className="px-4 py-1.5 rounded-full bg-terminal-surface/90 border border-terminal-border/60 backdrop-blur-sm text-xs font-mono text-terminal-dim flex items-center gap-2 shadow-lg">
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
          <div className="hidden md:block absolute top-3 right-3 px-3 py-1.5 rounded-md bg-terminal-orange/10 border border-terminal-orange/20 text-terminal-orange text-xs font-mono pause-overlay pointer-events-none backdrop-blur-sm">
            PAUSED
          </div>
        )}

        {/* Playback bar */}
        <div className="shrink-0 border-t border-terminal-border/50 bg-terminal-surface/80 backdrop-blur-sm sticky bottom-0 safe-bottom">
          <Timeline
            scenes={session.scenes}
            currentIndex={currentIndex}
            onSeek={seekFromNavigation}
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
          className={`absolute bottom-0 left-0 right-0 h-[65vh] bg-terminal-bg border-t border-terminal-border rounded-t-2xl flex flex-col transition-transform duration-300 safe-bottom ${
            mobileDrawerOpen ? "translate-y-0" : "translate-y-full"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle */}
          <div className="flex justify-center py-2.5 shrink-0">
            <div className="w-10 h-1 rounded-full bg-terminal-border" />
          </div>
          {/* Tabs */}
          <div className="flex border-b border-terminal-border/50 shrink-0">
            <button
              onClick={() => setSidebarTab("outline")}
              className={`flex-1 px-3 py-2.5 text-xs font-mono uppercase tracking-wider transition-colors ${
                sidebarTab === "outline"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim"
              }`}
            >
              Outline
            </button>
            <button
              onClick={() => setSidebarTab("stats")}
              className={`flex-1 px-3 py-2.5 text-xs font-mono uppercase tracking-wider transition-colors ${
                sidebarTab === "stats"
                  ? "text-terminal-green border-b-2 border-terminal-green"
                  : "text-terminal-dim"
              }`}
            >
              Stats
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
            ) : (
              <StatsPanel session={session} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
