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
        }
        else if (scene.type === "thinking") current.thinkingBlocks++;
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
    <div className="flex flex-col gap-px p-2 overflow-y-auto">
      {items.map((item, i) => {
        const isActive = i === activeIdx;
        const isPast = i < activeIdx;

        if (item.kind === "compaction") {
          return (
            <button
              key={`c-${item.promptIndex}`}
              onClick={() => onSeek(item.promptIndex)}
              className={`text-left px-3 py-2 rounded-md transition-all border border-dashed ${
                isActive
                  ? "border-terminal-dim/40 bg-terminal-dim/10"
                  : "border-terminal-border/30 hover:bg-terminal-surface/50 opacity-60 hover:opacity-100"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-terminal-dim/60 shrink-0">{"⟳"}</span>
                <span className="text-[11px] font-mono text-terminal-dim/70 italic truncate">
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
                {String(item.turnNumber).padStart(2, "0")}
              </span>
              <span className={`text-[13px] font-mono leading-snug line-clamp-2 ${
                isActive ? "text-terminal-text" : "text-terminal-text/80"
              }`}>
                {item.prompt}
              </span>
            </div>

            {/* Summary line */}
            <div className="flex items-center gap-2 mt-1.5 ml-6 flex-wrap">
              {item.toolCalls > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-orange/10 text-terminal-orange/80">
                  {item.toolCalls} tool{item.toolCalls > 1 ? "s" : ""}
                </span>
              )}
              {item.textBlocks > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-blue/10 text-terminal-blue/80">
                  {item.textBlocks} resp
                </span>
              )}
              {item.thinkingBlocks > 0 && (
                <span className="text-[11px] font-mono px-1.5 py-px rounded-sm bg-terminal-purple/10 text-terminal-purple/80">
                  think
                </span>
              )}
            </div>

            {/* Tool names (only for active turn) */}
            {isActive && item.toolNames.length > 0 && (
              <div className="mt-1.5 ml-6 text-[11px] font-mono text-terminal-dim truncate">
                {item.toolNames.join(", ")}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
