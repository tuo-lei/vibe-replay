import { useState, useCallback } from "react";
import type { PlayState } from "../hooks/usePlayback";

interface Props {
  state: PlayState;
  speed: number;
  currentIndex: number;
  totalScenes: number;
  userPromptCount: number;
  currentTurn: number;
  onTogglePlayPause: () => void;
  onChangeSpeed: (speed: number) => void;
  onPrevPrompt: () => void;
  onNextPrompt: () => void;
  onOpenSearch: () => void;
  onOpenOutline?: () => void;
  annotationCount?: number;
  annotationPanelOpen?: boolean;
  onToggleAnnotations?: () => void;
  hasUnsavedAnnotations?: boolean;
}

const SPEEDS = [1, 5, 10];

export default function Controls({
  state,
  speed,
  currentIndex,
  totalScenes,
  userPromptCount,
  currentTurn,
  onTogglePlayPause,
  onChangeSpeed,
  onPrevPrompt,
  onNextPrompt,
  onOpenSearch,
  onOpenOutline,
  annotationCount = 0,
  annotationPanelOpen = false,
  onToggleAnnotations,
  hasUnsavedAnnotations = false,
}: Props) {
  const isPlaying = state === "playing";
  const playIcon = isPlaying ? "\u23F8" : "\u25B6";
  const playLabel = isPlaying ? "Pause" : "Play";

  // Flash effect for button presses
  const [flashId, setFlashId] = useState<string | null>(null);
  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId(null), 300);
  }, []);

  const btnBase = "transition-all duration-150";
  const flashClass = (id: string) =>
    flashId === id ? "ring-2 ring-terminal-green/50 scale-105" : "";

  const groupStyle = "flex items-center border border-terminal-border/60 rounded-md overflow-hidden";
  const cellStyle = "px-2.5 md:px-2.5 py-2 md:py-1 text-xs font-mono";

  return (
    <div className="flex items-center justify-between px-3 md:px-4 py-2">
      <div className="flex items-center gap-1.5 md:gap-3">
        {/* Play/Pause */}
        <div className={groupStyle}>
          <button
            onClick={() => { flash("play"); onTogglePlayPause(); }}
            className={`${cellStyle} hover:text-terminal-green bg-terminal-surface ${btnBase} ${flashClass("play")}`}
            title="Play/Pause (Space)"
          >
            <span>{playIcon}</span>
            <span className="hidden sm:inline ml-1.5">{playLabel}</span>
          </button>
        </div>

        {/* Speed */}
        <div className={groupStyle}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => { flash(`speed-${s}`); onChangeSpeed(s); }}
              className={`${cellStyle} ${btnBase} ${
                speed === s
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text bg-terminal-surface"
              } ${flashClass(`speed-${s}`)}`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Turn navigation */}
        <div className={groupStyle}>
          <button
            onClick={() => { flash("prev"); onPrevPrompt(); }}
            className={`${cellStyle} text-terminal-dim hover:text-terminal-green bg-terminal-surface ${btnBase} ${flashClass("prev")}`}
            title="Previous turn (p)"
          >
            {"\u2039"}
          </button>
          <span className={`${cellStyle} text-terminal-dim tabular-nums bg-terminal-surface border-x border-terminal-border/60`}>
            <span className="hidden sm:inline">Turn </span>{currentTurn}/{userPromptCount}
          </span>
          <button
            onClick={() => { flash("next"); onNextPrompt(); }}
            className={`${cellStyle} text-terminal-dim hover:text-terminal-green bg-terminal-surface ${btnBase} ${flashClass("next")}`}
            title="Next turn (n)"
          >
            {"\u203A"}
          </button>
        </div>

        {/* Search */}
        <div className={groupStyle}>
          <button
            onClick={() => { flash("search"); onOpenSearch(); }}
            className={`${cellStyle} hover:text-terminal-blue bg-terminal-surface ${btnBase} ${flashClass("search")}`}
            title="Search (Cmd/Ctrl+K)"
          >
            <span>{"\uD83D\uDD0D"}</span>
            <span className="hidden sm:inline ml-1.5">Search</span>
          </button>
        </div>

        {/* Annotations toggle */}
        {onToggleAnnotations && (
          <div className={`${groupStyle} hidden md:flex`}>
            <button
              onClick={() => { flash("annotate"); onToggleAnnotations(); }}
              className={`${cellStyle} ${btnBase} ${
                annotationPanelOpen
                  ? "bg-terminal-blue/15 text-terminal-blue"
                  : "hover:text-terminal-blue bg-terminal-surface"
              } ${flashClass("annotate")} relative`}
              title="Toggle comments panel"
            >
              <span>{"\uD83D\uDCAC"}</span>
              {annotationCount > 0 && (
                <span className="hidden sm:inline ml-1.5">{annotationCount}</span>
              )}
              {hasUnsavedAnnotations && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-terminal-orange" />
              )}
            </button>
          </div>
        )}

        {/* Outline (mobile only) */}
        {onOpenOutline && (
          <div className={`${groupStyle} md:hidden`}>
            <button
              onClick={() => { flash("outline"); onOpenOutline(); }}
              className={`${cellStyle} hover:text-terminal-text bg-terminal-surface ${btnBase} ${flashClass("outline")}`}
              title="Outline"
            >
              {"\u2630"}
            </button>
          </div>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-2 md:gap-3 text-xs text-terminal-dim font-mono shrink-0">
        {state === "paused" && (
          <span className="text-terminal-orange">PAUSED</span>
        )}
        <span className="tabular-nums">
          {Math.max(0, currentIndex + 1)} / {totalScenes}
        </span>
        {/* Keyboard hints — desktop only */}
        <span className="hidden lg:inline-flex items-center gap-2 text-terminal-dim/50 border-l border-terminal-border/40 pl-3">
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">Space</kbd>
          <span className="text-[10px]">play</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">n</kbd>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">p</kbd>
          <span className="text-[10px]">turns</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">&larr;&rarr;</kbd>
          <span className="text-[10px]">step</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">e</kbd>
          <span className="text-[10px]">all</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">⌘K</kbd>
          <span className="text-[10px]">search</span>
        </span>
      </div>
    </div>
  );
}
