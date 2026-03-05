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
}: Props) {
  const isPlaying = state === "playing";
  const playIcon = isPlaying ? "\u23F8" : "\u25B6";
  const playLabel = isPlaying ? "Pause" : "Play";

  return (
    <div className="flex items-center justify-between px-4 py-2">
      <div className="flex items-center gap-3">
        <button
          onClick={onTogglePlayPause}
          className="h-8 flex items-center gap-1.5 px-3 rounded-md bg-terminal-surface border border-terminal-border/60 hover:border-terminal-green hover:text-terminal-green transition-colors text-xs font-mono"
          title="Play/Pause (Space)"
        >
          <span>{playIcon}</span>
          <span>{playLabel}</span>
        </button>

        <div className="flex items-center border border-terminal-border/60 rounded-md overflow-hidden">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onChangeSpeed(s)}
              className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                speed === s
                  ? "bg-terminal-green/15 text-terminal-green"
                  : "text-terminal-dim hover:text-terminal-text bg-terminal-surface"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-1">
          <button
            onClick={onPrevPrompt}
            className="px-2 py-1 text-xs font-mono text-terminal-dim hover:text-terminal-green transition-colors"
            title="Previous turn (p)"
          >
            {"<"}
          </button>
          <span className="text-xs font-mono text-terminal-dim px-1 tabular-nums">
            Turn {currentTurn}/{userPromptCount}
          </span>
          <button
            onClick={onNextPrompt}
            className="px-2 py-1 text-xs font-mono text-terminal-dim hover:text-terminal-green transition-colors"
            title="Next turn (n)"
          >
            {">"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-terminal-dim font-mono">
        {state === "paused" && (
          <span className="text-terminal-orange">PAUSED</span>
        )}
        <span className="tabular-nums">
          {Math.max(0, currentIndex + 1)} / {totalScenes}
        </span>
        <span className="hidden sm:inline-flex items-center gap-2 text-terminal-dim/50 border-l border-terminal-border/40 pl-3">
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">Space</kbd>
          <span className="text-[10px]">play</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">n</kbd>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">p</kbd>
          <span className="text-[10px]">turns</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">&larr;&rarr;</kbd>
          <span className="text-[10px]">step</span>
          <kbd className="px-1 py-px rounded bg-terminal-surface border border-terminal-border/50 text-[10px]">e</kbd>
          <span className="text-[10px]">all</span>
        </span>
      </div>
    </div>
  );
}
