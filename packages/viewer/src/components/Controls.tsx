import { useCallback, useState } from "react";
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
  commentDrawerOpen?: boolean;
  onToggleAnnotations?: () => void;
  hasUnsavedAnnotations?: boolean;
  onShowHelp?: () => void;
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
  annotationCount: _annotationCount = 0,
  commentDrawerOpen: _commentDrawerOpen = false,
  onToggleAnnotations: _onToggleAnnotations,
  hasUnsavedAnnotations: _hasUnsavedAnnotations = false,
  onShowHelp,
}: Props) {
  const isPlaying = state === "playing";
  const playIcon = isPlaying ? "\u23F8" : "\u25B6";
  const playLabel = isPlaying ? "Pause" : "Play";

  const [flashId, setFlashId] = useState<string | null>(null);
  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId(null), 300);
  }, []);

  const flashClass = (id: string) => (flashId === id ? "scale-105" : "");

  const ghostBtn =
    "px-2.5 py-1.5 text-xs font-sans rounded-lg transition-all duration-200 ease-material";

  return (
    <div className="flex items-center justify-between px-4 md:px-5 py-2.5">
      <div className="flex items-center gap-1 md:gap-2">
        {/* Play/Pause — primary action */}
        <button
          onClick={() => {
            flash("play");
            onTogglePlayPause();
          }}
          className={`${ghostBtn} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis font-medium ${flashClass("play")}`}
          title="Play/Pause (Space)"
        >
          <span>{playIcon}</span>
          <span className="hidden sm:inline ml-1.5">{playLabel}</span>
        </button>

        {/* Speed — grouped with bg */}
        <div className="flex items-center rounded-lg bg-terminal-surface overflow-hidden">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => {
                flash(`speed-${s}`);
                onChangeSpeed(s);
              }}
              className={`px-2.5 py-1.5 text-xs font-mono transition-all duration-200 ease-material ${
                speed === s
                  ? "bg-terminal-green-subtle text-terminal-green font-medium"
                  : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
              } ${flashClass(`speed-${s}`)}`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Turn navigation */}
        <div className="flex items-center">
          <button
            onClick={() => {
              flash("prev");
              onPrevPrompt();
            }}
            className={`${ghostBtn} text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover ${flashClass("prev")}`}
            title="Previous turn (p)"
          >
            {"\u2039"}
          </button>
          <span className="px-1.5 py-1.5 text-xs font-sans text-terminal-dim tabular-nums flex items-center gap-1">
            <span className="hidden sm:inline">Turn </span>
            <span className="font-mono">{currentTurn}</span>
            <span>/</span>
            <span className="font-mono">{userPromptCount}</span>
          </span>
          <button
            onClick={() => {
              flash("next");
              onNextPrompt();
            }}
            className={`${ghostBtn} text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover ${flashClass("next")}`}
            title="Next turn (n)"
          >
            {"\u203A"}
          </button>
        </div>
      </div>

      {/* Search - Flexible Grow */}
      <button
        onClick={() => {
          flash("search");
          onOpenSearch();
        }}
        className={`h-8 flex-grow flex items-center gap-3 px-3 rounded-lg bg-terminal-surface/20 border border-terminal-border-subtle hover:border-terminal-blue/40 hover:bg-terminal-blue-subtle/20 group/search transition-all duration-200 max-w-sm ${flashClass("search")}`}
        title="Search (/ or Cmd+K)"
      >
        <span className="text-sm opacity-70 group-hover/search:opacity-100 transition-opacity">
          {"\uD83D\uDD0D"}
        </span>
        <span className="text-[11px] font-sans font-medium text-terminal-dim group-hover/search:text-terminal-blue transition-colors">
          Search...
        </span>
        <div className="flex items-center gap-1 ml-1 opacity-40 group-hover/search:opacity-80 transition-opacity">
          <span className="px-1 py-0.5 rounded bg-terminal-surface border border-terminal-border/50 text-[9px] font-mono font-bold text-terminal-text">
            /
          </span>
        </div>
      </button>

      {/* Right side items */}
      <div className="flex items-center gap-2 md:gap-4">
        {/* Outline (mobile only) */}
        {onOpenOutline && (
          <button
            onClick={() => {
              flash("outline");
              onOpenOutline();
            }}
            className={`${ghostBtn} md:hidden text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover ${flashClass("outline")}`}
            title="Outline"
          >
            {"\u2630"}
          </button>
        )}

        {/* Shortcuts Help */}
        {onShowHelp && (
          <button
            onClick={() => {
              flash("help");
              onShowHelp();
            }}
            className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-terminal-dimmer hover:text-terminal-text hover:bg-terminal-surface-hover group/help transition-all duration-200 ${flashClass("help")}`}
            title="Keyboard Shortcuts (?)"
          >
            <div className="flex items-center justify-center w-5 h-5 rounded border border-terminal-border-subtle/50 bg-terminal-surface group-hover/help:border-terminal-text group-hover/help:text-terminal-bg group-hover/help:bg-terminal-text transition-all duration-200">
              <span className="text-[11px] font-mono font-black">?</span>
            </div>
            <span className="hidden lg:inline text-[10px] font-sans font-bold uppercase tracking-widest opacity-60 group-hover/help:opacity-100">
              Press ? for help
            </span>
          </button>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-2 md:gap-3 text-xs text-terminal-dim font-mono shrink-0">
        {state === "paused" && (
          <span className="text-[10px] font-sans font-semibold uppercase tracking-widest text-terminal-orange">
            Paused
          </span>
        )}
        <span className="tabular-nums">
          {Math.max(0, currentIndex + 1)} / {totalScenes}
        </span>
      </div>
    </div>
  );
}
