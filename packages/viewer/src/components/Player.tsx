import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { ReplaySession, Scene } from "../types";
import type { ViewPrefs } from "../hooks/useViewPrefs";
import { usePlayback } from "../hooks/usePlayback";
import Timeline from "./Timeline";
import Controls from "./Controls";
import ConversationView from "./ConversationView";
import Minimap from "./Minimap";
import StatsPanel from "./StatsPanel";

interface Props {
  session: ReplaySession;
  viewPrefs: ViewPrefs;
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export default function Player({ session, viewPrefs }: Props) {
  const {
    state,
    currentIndex,
    visibleCount,
    speed,
    play,
    togglePlayPause,
    seekTo,
    changeSpeed,
    totalScenes,
    jumpToNextUserPrompt,
    jumpToPrevUserPrompt,
    userPromptIndices,
  } = usePlayback(session.scenes, viewPrefs.promptsOnly);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sidebarTab, setSidebarTab] = useState<"outline" | "stats">("outline");

  const currentTurn =
    userPromptIndices.filter((i) => i <= currentIndex).length || 0;
  const userPromptCount = userPromptIndices.length;

  // Auto-play after 1.5s delay
  useEffect(() => {
    const timer = setTimeout(play, 1500);
    return () => clearTimeout(timer);
  }, [play]);

  // Auto-scroll to current scene (skip when user is scrolling to reveal)
  const userScrollingRef = useRef(false);
  useEffect(() => {
    if (!scrollRef.current || currentIndex < 0 || userScrollingRef.current) return;
    const el = scrollRef.current;
    requestAnimationFrame(() => {
      const sceneEl = el.querySelector(`[data-scene-index="${currentIndex}"]`);
      if (sceneEl) {
        sceneEl.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    });
  }, [currentIndex]);

  // Scroll-to-reveal: when paused and user scrolls near bottom, advance scenes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let throttle = false;
    const handleScroll = () => {
      if (state !== "paused" || throttle) return;
      if (currentIndex >= session.scenes.length - 1) return;

      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) {
        throttle = true;
        userScrollingRef.current = true;
        seekTo(currentIndex + 1);
        // Reset after a brief delay to allow new content to render
        setTimeout(() => {
          throttle = false;
          userScrollingRef.current = false;
        }, 150);
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [state, currentIndex, session.scenes.length, seekTo]);

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
              onSeek={seekTo}
            />
          ) : (
            <StatsPanel session={session} />
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          <ConversationView
            scenes={session.scenes}
            visibleCount={visibleCount}
            currentIndex={currentIndex}
            viewPrefs={viewPrefs}
          />
        </div>

        {/* Pause overlay */}
        {state === "paused" && visibleCount > 0 && (
          <div className="absolute top-3 right-3 md:right-3 px-3 py-1.5 rounded-md bg-terminal-orange/10 border border-terminal-orange/20 text-terminal-orange text-xs font-mono pause-overlay pointer-events-none backdrop-blur-sm">
            PAUSED
          </div>
        )}

        {/* Playback bar */}
        <div className="shrink-0 border-t border-terminal-border/50 bg-terminal-surface/80 backdrop-blur-sm sticky bottom-0">
          <Timeline
            scenes={session.scenes}
            currentIndex={currentIndex}
            onSeek={seekTo}
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
            onPrevPrompt={jumpToPrevUserPrompt}
            onNextPrompt={jumpToNextUserPrompt}
          />
        </div>
      </div>
    </div>
  );
}
