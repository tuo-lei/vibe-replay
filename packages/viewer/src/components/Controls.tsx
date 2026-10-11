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
  onShowHelp?: () => void;
  /** Reserve room for the fixed Ask Replay launcher in editor mode. */
  reserveAssistantSpace?: boolean;
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
  onShowHelp,
  reserveAssistantSpace = false,
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
    "px-2.5 py-1.5 text-xs font-sans rounded-lg transition-[color,background-color,transform] duration-200 ease-material";

  // Mobile touch target size
  const touchBtn =
    "w-11 h-11 shrink-0 flex items-center justify-center rounded-lg transition-[color,background-color,transform] duration-200 ease-material";

  return (
    <>
      {/* Mobile controls — evenly distributed */}
      <div
        className={`md:hidden space-y-1 py-1.5 pl-3 ${reserveAssistantSpace ? "pr-20" : "pr-3"}`}
      >
        <div className="flex items-center justify-between gap-2">
          <button
            aria-label={playLabel}
            onClick={() => {
              flash("play");
              onTogglePlayPause();
            }}
            className={`${touchBtn} bg-terminal-green-subtle text-terminal-green ${flashClass("play")}`}
            title="Play/Pause"
          >
            <span className="text-base">{playIcon}</span>
          </button>
          <fieldset
            aria-label="Playback speed"
            className="flex rounded-lg bg-terminal-surface overflow-hidden"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Playback speed ${s}x`}
                aria-pressed={speed === s}
                onClick={() => onChangeSpeed(s)}
                className={`min-w-9 h-11 px-2 text-xs font-mono transition-colors ${speed === s ? "bg-terminal-green-subtle text-terminal-green" : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"}`}
              >
                {s}×
              </button>
            ))}
          </fieldset>
          <span className="text-[10px] font-mono text-terminal-dim tabular-nums">
            {Math.max(0, currentIndex + 1)} / {totalScenes}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              flash("prev");
              onPrevPrompt();
            }}
            className={`${touchBtn} bg-terminal-surface text-terminal-text ${flashClass("prev")}`}
            title="Previous turn"
            aria-label="Previous turn"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>

          <span className="text-xs font-mono text-terminal-text tabular-nums font-medium">
            {currentTurn} / {userPromptCount}
          </span>

          <button
            onClick={() => {
              flash("next");
              onNextPrompt();
            }}
            className={`${touchBtn} bg-terminal-surface text-terminal-text ${flashClass("next")}`}
            title="Next turn"
            aria-label="Next turn"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>

          <button
            onClick={() => {
              flash("search");
              onOpenSearch();
            }}
            className={`${touchBtn} bg-terminal-surface text-terminal-text ${flashClass("search")}`}
            title="Search"
            aria-label="Search"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>

          {onOpenOutline && (
            <button
              onClick={() => {
                flash("outline");
                onOpenOutline();
              }}
              className={`${touchBtn} bg-terminal-surface border border-terminal-border text-terminal-text ${flashClass("outline")}`}
              title="Outline"
              aria-label="Open outline"
            >
              {"\u2630"}
            </button>
          )}
        </div>
      </div>

      {/* Desktop controls */}
      <div
        className={`hidden md:flex items-center justify-between py-2.5 pl-5 ${
          reserveAssistantSpace ? "pr-32" : "pr-5"
        }`}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              flash("play");
              onTogglePlayPause();
            }}
            className={`${ghostBtn} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis font-medium ${flashClass("play")}`}
            title="Play/Pause (Space)"
            aria-label={playLabel}
          >
            <span>{playIcon}</span>
            <span className="ml-1.5">{playLabel}</span>
          </button>

          <div className="flex items-center rounded-lg bg-terminal-surface overflow-hidden">
            {SPEEDS.map((s) => (
              <button
                key={s}
                aria-label={`Playback speed ${s}x`}
                aria-pressed={speed === s}
                onClick={() => {
                  flash(`speed-${s}`);
                  onChangeSpeed(s);
                }}
                className={`px-2.5 py-1.5 text-xs font-mono transition-[color,background-color,transform] duration-200 ease-material ${
                  speed === s
                    ? "bg-terminal-green-subtle text-terminal-green font-medium"
                    : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                } ${flashClass(`speed-${s}`)}`}
              >
                {s}x
              </button>
            ))}
          </div>

          <div className="flex items-center">
            <button
              onClick={() => {
                flash("prev");
                onPrevPrompt();
              }}
              className={`${ghostBtn} text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover ${flashClass("prev")}`}
              title="Previous turn (p)"
              aria-label="Previous turn"
            >
              {"\u2039"}
            </button>
            <span className="px-1.5 py-1.5 text-xs font-sans text-terminal-dim tabular-nums flex items-center gap-1">
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
              aria-label="Next turn"
            >
              {"\u203A"}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
              Type / to search
            </span>
            <div className="flex items-center gap-1 ml-1 opacity-40 group-hover/search:opacity-80 transition-opacity">
              <span className="px-1 py-0.5 rounded bg-terminal-surface border border-terminal-border/50 text-[9px] font-mono font-bold text-terminal-text">
                /
              </span>
            </div>
          </button>

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

          <div className="flex items-center gap-2 md:gap-3 text-xs text-terminal-dim font-mono shrink-0">
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
      </div>
    </>
  );
}
