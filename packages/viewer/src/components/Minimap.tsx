import { useMemo } from "react";
import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  currentIndex: number;
  onSeek: (index: number) => void;
}

interface TurnOutline {
  kind: "turn";
  turnNumber: number;
  promptIndex: number;
  prompt: string;
  toolCalls: number;
  toolNames: string[];
  thinkingBlocks: number;
  textBlocks: number;
  endIndex: number;
}

interface CompactionOutline {
  kind: "compaction";
  promptIndex: number;
  preview: string;
}

type OutlineItem = TurnOutline | CompactionOutline;

export default function Minimap({ scenes, currentIndex, onSeek }: Props) {
  const items = useMemo(() => {
    const result: OutlineItem[] = [];
    let current: TurnOutline | null = null;
    let turnCount = 0;

    scenes.forEach((scene, i) => {
      if (scene.type === "user-prompt") {
        if (current) {
          current.endIndex = i - 1;
          result.push(current);
        }
        turnCount++;
        current = {
          kind: "turn",
          turnNumber: turnCount,
          promptIndex: i,
          prompt: scene.content.replace(/\n/g, " ").slice(0, 120),
          toolCalls: 0,
          toolNames: [],
          thinkingBlocks: 0,
          textBlocks: 0,
          endIndex: i,
        };
      } else if (scene.type === "compaction-summary") {
        if (current) {
          current.endIndex = i - 1;
          result.push(current);
          current = null;
        }
        result.push({
          kind: "compaction",
          promptIndex: i,
          preview: scene.content.replace(/\n/g, " ").slice(0, 80),
        });
      } else if (current) {
        current.endIndex = i;
        if (scene.type === "tool-call") {
          current.toolCalls++;
          if (!current.toolNames.includes(scene.toolName)) {
            current.toolNames.push(scene.toolName);
          }
        } else if (scene.type === "thinking") current.thinkingBlocks++;
        else if (scene.type === "text-response") current.textBlocks++;
      }
    });
    if (current) result.push(current);
    return result;
  }, [scenes]);

  const activeIdx = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (currentIndex >= items[i].promptIndex) return i;
    }
    return -1;
  }, [items, currentIndex]);

  return (
    <div className="flex flex-col gap-1 p-3.5 overflow-y-auto">
      {items.map((item, i) => {
        const isActive = i === activeIdx;
        const isPast = i < activeIdx;

        if (item.kind === "compaction") {
          return (
            <button
              key={`c-${item.promptIndex}`}
              onClick={() => onSeek(item.promptIndex)}
              className={`text-left px-3 py-2 rounded-lg transition-all duration-200 ease-material ${
                isActive
                  ? "bg-terminal-surface border-l-2 border-terminal-dim shadow-layer-sm"
                  : "hover:bg-terminal-surface-hover text-terminal-dimmer hover:text-terminal-dim"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-terminal-dimmer shrink-0">{"⟳"}</span>
                <span className="text-xs font-mono text-terminal-dimmer italic truncate">
                  Context compacted
                </span>
              </div>
            </button>
          );
        }

        return (
          <button
            key={`t-${item.promptIndex}`}
            onClick={() => onSeek(item.promptIndex)}
            className={`group text-left px-3 py-2.5 rounded-xl transition-all duration-200 ease-material ${
              isActive
                ? "bg-terminal-green-subtle border-l-2 border-terminal-green shadow-layer-sm"
                : isPast
                  ? "hover:bg-terminal-surface-hover text-terminal-dim hover:text-terminal-text"
                  : "hover:bg-terminal-surface-hover"
            }`}
          >
            {/* Turn header */}
            <div className="flex items-start gap-2">
              <span
                className={`text-xs font-mono font-semibold shrink-0 mt-px tabular-nums ${
                  isActive ? "text-terminal-green" : "text-terminal-dim"
                }`}
              >
                {String(item.turnNumber).padStart(2, "0")}
              </span>
              <span
                className={`text-sm font-mono leading-snug line-clamp-2 ${
                  isActive ? "text-terminal-text" : "text-terminal-text"
                }`}
              >
                {item.prompt}
              </span>
            </div>

            {/* Summary line */}
            <div className="flex items-center gap-2 mt-1.5 ml-6 flex-wrap">
              {item.toolCalls > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-orange-subtle text-terminal-orange">
                  {item.toolCalls} tool{item.toolCalls > 1 ? "s" : ""}
                </span>
              )}
              {item.textBlocks > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-blue-subtle text-terminal-blue">
                  {item.textBlocks} resp
                </span>
              )}
              {item.thinkingBlocks > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-purple-subtle text-terminal-purple">
                  think
                </span>
              )}
            </div>

            {/* Tool names (only for active turn) */}
            {isActive && item.toolNames.length > 0 && (
              <div className="mt-1.5 ml-6 text-xs font-mono text-terminal-dim truncate">
                {item.toolNames.join(", ")}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
