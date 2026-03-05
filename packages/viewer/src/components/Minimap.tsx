import { useMemo } from "react";
import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  currentIndex: number;
  onSeek: (index: number) => void;
}

interface TurnOutline {
  turnNumber: number;
  promptIndex: number;
  prompt: string;
  toolCalls: number;
  toolNames: string[];
  thinkingBlocks: number;
  textBlocks: number;
  endIndex: number;
}

export default function Minimap({ scenes, currentIndex, onSeek }: Props) {
  const turns = useMemo(() => {
    const groups: TurnOutline[] = [];
    let current: TurnOutline | null = null;

    scenes.forEach((scene, i) => {
      if (scene.type === "user-prompt") {
        if (current) {
          current.endIndex = i - 1;
          groups.push(current);
        }
        current = {
          turnNumber: groups.length + 1,
          promptIndex: i,
          prompt: scene.content.replace(/\n/g, " ").slice(0, 120),
          toolCalls: 0,
          toolNames: [],
          thinkingBlocks: 0,
          textBlocks: 0,
          endIndex: i,
        };
      } else if (current) {
        current.endIndex = i;
        if (scene.type === "tool-call") {
          current.toolCalls++;
          if (!current.toolNames.includes(scene.toolName)) {
            current.toolNames.push(scene.toolName);
          }
        }
        else if (scene.type === "thinking") current.thinkingBlocks++;
        else if (scene.type === "text-response") current.textBlocks++;
      }
    });
    if (current) groups.push(current);
    return groups;
  }, [scenes]);

  const activeTurnIdx = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (currentIndex >= turns[i].promptIndex) return i;
    }
    return -1;
  }, [turns, currentIndex]);

  return (
    <div className="flex flex-col gap-px p-2 overflow-y-auto">
      {turns.map((turn, i) => {
        const isActive = i === activeTurnIdx;
        const isPast = i < activeTurnIdx;

        return (
          <button
            key={i}
            onClick={() => onSeek(turn.promptIndex)}
            className={`group text-left px-3 py-2.5 rounded-md transition-all ${
              isActive
                ? "bg-terminal-green/8 border border-terminal-green/25"
                : isPast
                ? "border border-transparent hover:bg-terminal-surface/80 opacity-70 hover:opacity-100"
                : "border border-transparent hover:bg-terminal-surface/80"
            }`}
          >
            {/* Turn header */}
            <div className="flex items-start gap-2">
              <span className={`text-xs font-mono font-semibold shrink-0 mt-px tabular-nums ${
                isActive ? "text-terminal-green" : "text-terminal-dim"
              }`}>
                {String(turn.turnNumber).padStart(2, "0")}
              </span>
              <span className={`text-[13px] font-mono leading-snug line-clamp-2 ${
                isActive ? "text-terminal-text" : "text-terminal-text/80"
              }`}>
                {turn.prompt}
              </span>
            </div>

            {/* Summary line */}
            <div className="flex items-center gap-2 mt-1.5 ml-6 flex-wrap">
              {turn.toolCalls > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-orange/10 text-terminal-orange/80">
                  {turn.toolCalls} tool{turn.toolCalls > 1 ? "s" : ""}
                </span>
              )}
              {turn.textBlocks > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-blue/10 text-terminal-blue/80">
                  {turn.textBlocks} resp
                </span>
              )}
              {turn.thinkingBlocks > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-purple/10 text-terminal-purple/80">
                  think
                </span>
              )}
            </div>

            {/* Tool names (only for active turn) */}
            {isActive && turn.toolNames.length > 0 && (
              <div className="mt-1.5 ml-6 text-[11px] font-mono text-terminal-dim truncate">
                {turn.toolNames.join(", ")}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
