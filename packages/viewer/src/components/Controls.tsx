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

  return (
    <div className="flex items-center justify-between px-3 md:px-4 py-2">
      <div className="flex items-center gap-1.5 md:gap-3">
        <button
          onClick={() => { flash("play"); onTogglePlayPause(); }}
          className={`h-9 md:h-8 flex items-center gap-1.5 px-3 rounded-md bg-terminal-surface border border-terminal-border/60 hover:border-terminal-green hover:text-terminal-green text-xs font-mono ${btnBase} ${flashClass("play")}`}
          title="Play/Pause (Space)"
        >
          <span>{playIcon}</span>
          <span className="hidden sm:inline">{playLabel}</span>
        </button>

        <div className="flex items-center border border-terminal-border/60 rounded-md overflow-hidden">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => { flash(`speed-${s}`); onChangeSpeed(s); }}
              className={`px-2 md:px-2.5 py-1.5 md:py-1 text-xs font-mono ${btnBase} ${
                speed === s
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text bg-terminal-surface"
              } ${flashClass(`speed-${s}`)}`}
            >
              {s}x
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 md:gap-1 ml-0.5 md:ml-1">
          <button
            onClick={() => { flash("prev"); onPrevPrompt(); }}
            className={`px-2 py-1.5 md:py-1 text-xs font-mono text-terminal-dim hover:text-terminal-green ${btnBase} ${flashClass("prev")}`}
            title="Previous turn (p)"
          >
            {"<"}
          </button>
          <span className="text-xs font-mono text-terminal-dim px-0.5 md:px-1 tabular-nums">
            <span className="hidden sm:inline">Turn </span>{currentTurn}/{userPromptCount}
          </span>
          <button
            onClick={() => { flash("next"); onNextPrompt(); }}
            className={`px-2 py-1.5 md:py-1 text-xs font-mono text-terminal-dim hover:text-terminal-green ${btnBase} ${flashClass("next")}`}
            title="Next turn (n)"
          >
            {">"}
          </button>
        </div>

        <button
          onClick={() => { flash("search"); onOpenSearch(); }}
          className={`h-9 md:h-8 flex items-center gap-1.5 px-2.5 md:px-3 rounded-md bg-terminal-surface border border-terminal-border/60 hover:border-terminal-blue hover:text-terminal-blue text-xs font-mono ${btnBase} ${flashClass("search")}`}
          title="Search (Cmd/Ctrl+K)"
        >
          <span>{"\uD83D\uDD0D"}</span>
          <span className="hidden sm:inline">Search</span>
        </button>

        {onOpenOutline && (
          <button
            onClick={() => { flash("outline"); onOpenOutline(); }}
            className={`md:hidden h-9 flex items-center px-2.5 rounded-md bg-terminal-surface border border-terminal-border/60 hover:border-terminal-text text-xs font-mono ${btnBase} ${flashClass("outline")}`}
            title="Outline"
          >
            {"\u2630"}
          </button>
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
