import { useMemo } from "react";
import { getTurnStat } from "../engine";
import type { OverlayActions } from "../hooks/useOverlays";
import type { Scene, TurnStat } from "../types";
import { formatDuration } from "./StatsPanel";

interface Props {
  scenes: Scene[];
  currentIndex: number;
  onSeek: (index: number) => void;
  overlayActions?: OverlayActions;
  turnStats?: TurnStat[];
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
  subAgentCalls: number;
  endIndex: number;
}

interface CompactionOutline {
  kind: "compaction" | "injection";
  promptIndex: number;
  preview: string;
}

type OutlineItem = TurnOutline | CompactionOutline;

export default function Minimap({
  scenes,
  currentIndex,
  onSeek,
  overlayActions,
  turnStats,
}: Props) {
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
        const effectiveContent = overlayActions?.getEffectiveContent(i);
        const displayContent = effectiveContent ?? scene.content;
        current = {
          kind: "turn",
          turnNumber: turnCount,
          promptIndex: i,
          prompt: displayContent.replace(/\n/g, " ").slice(0, 120),
          toolCalls: 0,
          toolNames: [],
          thinkingBlocks: 0,
          textBlocks: 0,
          subAgentCalls: 0,
          endIndex: i,
        };
      } else if (scene.type === "compaction-summary" || scene.type === "context-injection") {
        if (current) {
          current.endIndex = i - 1;
          result.push(current);
          current = null;
        }
        result.push({
          kind: scene.type === "context-injection" ? "injection" : "compaction",
          promptIndex: i,
          preview: scene.content.replace(/\n/g, " ").slice(0, 80),
        });
      } else if (current) {
        current.endIndex = i;
        if (scene.type === "tool-call") {
          current.toolCalls++;
          if (scene.toolName === "Agent" && scene.subAgent) current.subAgentCalls++;
          if (!current.toolNames.includes(scene.toolName)) {
            current.toolNames.push(scene.toolName);
          }
        } else if (scene.type === "thinking") current.thinkingBlocks++;
        else if (scene.type === "text-response") current.textBlocks++;
      }
    });
    if (current) result.push(current);
    return result;
    // `useOverlays` returns a fresh object each render; depending on
    // `overlayActions` would invalidate this memo on every render. The
    // method itself is `useCallback`-stable, so tracking just it is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, overlayActions?.getEffectiveContent]);

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

        if (item.kind !== "turn") {
          const label = item.kind === "injection" ? "System context" : "Context compacted";
          const icon = item.kind === "injection" ? "⚡" : "⟳";
          return (
            <button
              key={`c-${item.promptIndex}`}
              onClick={() => onSeek(item.promptIndex)}
              aria-label={label}
              className={`text-left px-3 py-2 rounded-lg transition-all duration-200 ease-material ${
                isActive
                  ? "bg-terminal-context-subtle text-terminal-context shadow-layer-sm"
                  : "text-terminal-context/75 hover:bg-terminal-context-subtle hover:text-terminal-context"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-terminal-context shrink-0">{icon}</span>
                <span className="text-xs font-mono text-terminal-context italic truncate">
                  {label}
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
                ? "bg-terminal-user-subtle shadow-layer-sm"
                : isPast
                  ? "hover:bg-terminal-surface-hover text-terminal-dim hover:text-terminal-text"
                  : "hover:bg-terminal-surface-hover"
            }`}
          >
            {/* Turn header */}
            <div className="flex items-start gap-2">
              <span
                className={`text-xs font-mono font-semibold shrink-0 mt-px tabular-nums ${
                  isActive ? "text-terminal-user" : "text-terminal-dim"
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
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-tool-subtle text-terminal-tool">
                  {item.toolCalls} tool{item.toolCalls > 1 ? "s" : ""}
                </span>
              )}
              {item.subAgentCalls > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-thinking-subtle text-terminal-thinking">
                  {item.subAgentCalls} agent{item.subAgentCalls > 1 ? "s" : ""}
                </span>
              )}
              {item.textBlocks > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-response-subtle text-terminal-response">
                  {item.textBlocks} resp
                </span>
              )}
              {item.thinkingBlocks > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-terminal-thinking-subtle text-terminal-thinking">
                  think
                </span>
              )}
              {(() => {
                const ts = getTurnStat(turnStats, item.turnNumber - 1);
                if (!ts?.durationMs) return null;
                return (
                  <span className="text-[10px] font-mono text-terminal-dimmer">
                    {formatDuration(ts.durationMs)}
                  </span>
                );
              })()}
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
