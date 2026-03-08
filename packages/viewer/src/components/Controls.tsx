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

  const [flashId, setFlashId] = useState<string | null>(null);
  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId(null), 300);
  }, []);

  const flashClass = (id: string) => (flashId === id ? "scale-105" : "");

  const ghostBtn =
    "px-2.5 py-1.5 text-xs font-mono rounded-lg transition-all duration-200 ease-material";

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
          <span className="px-1.5 py-1.5 text-xs font-mono text-terminal-dim tabular-nums">
            <span className="hidden sm:inline">Turn </span>
            {currentTurn}/{userPromptCount}
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

        {/* Search */}
        <button
          onClick={() => {
            flash("search");
            onOpenSearch();
          }}
          className={`${ghostBtn} text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle ${flashClass("search")}`}
          title="Search (Cmd/Ctrl+K)"
        >
          <span>{"\uD83D\uDD0D"}</span>
          <span className="hidden sm:inline ml-1.5">Search</span>
        </button>

        {/* Annotations toggle */}
        {onToggleAnnotations && (
          <button
            onClick={() => {
              flash("annotate");
              onToggleAnnotations();
            }}
            className={`${ghostBtn} hidden md:inline-flex items-center ${
              annotationPanelOpen
                ? "bg-terminal-blue-subtle text-terminal-blue"
                : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle"
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
        )}

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
        {/* Keyboard hints — minimal, no decorative borders */}
        <span className="hidden lg:inline-flex items-center gap-2 text-terminal-dimmer pl-3">
          <kbd className="text-xs">Space</kbd>
          <span className="text-xs">play</span>
          <kbd className="text-xs">n</kbd>
          <kbd className="text-xs">p</kbd>
          <span className="text-xs">turns</span>
          <kbd className="text-xs">&larr;&rarr;</kbd>
          <span className="text-xs">step</span>
          <kbd className="text-xs">e</kbd>
          <span className="text-xs">all</span>
          <kbd className="text-xs">⌘K</kbd>
          <span className="text-xs">search</span>
        </span>
      </div>
    </div>
  );
}
