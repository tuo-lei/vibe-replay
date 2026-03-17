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

  // Mobile touch target size
  const touchBtn =
    "w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-200 ease-material";

  return (
    <>
      {/* Mobile controls — evenly distributed */}
      <div className="flex md:hidden items-center justify-between px-3 py-1.5">
        <button
          onClick={() => {
            flash("play");
            onTogglePlayPause();
          }}
          className={`${touchBtn} bg-terminal-green-subtle text-terminal-green ${flashClass("play")}`}
          title="Play/Pause"
        >
          <span className="text-base">{playIcon}</span>
        </button>

        <button
          onClick={() => {
            flash("prev");
            onPrevPrompt();
          }}
          className={`${touchBtn} bg-terminal-surface text-terminal-text ${flashClass("prev")}`}
          title="Previous turn"
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
          >
            {"\u2630"}
          </button>
        )}
      </div>

      {/* Desktop controls */}
      <div className="hidden md:flex items-center justify-between px-5 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              flash("play");
              onTogglePlayPause();
            }}
            className={`${ghostBtn} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis font-medium ${flashClass("play")}`}
            title="Play/Pause (Space)"
          >
            <span>{playIcon}</span>
            <span className="ml-1.5">{playLabel}</span>
          </button>

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
