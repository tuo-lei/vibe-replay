import { useMemo, useState } from "react";
import type { Scene } from "../types";
import type { ViewPrefs } from "../hooks/useViewPrefs";
import UserPromptBlock from "./UserPromptBlock";
import ThinkingBlock from "./ThinkingBlock";
import TextResponseBlock from "./TextResponseBlock";
import ToolCallBlock from "./ToolCallBlock";

interface Props {
  scenes: Scene[];
  visibleCount: number;
  currentIndex: number;
  viewPrefs: ViewPrefs;
}

interface TurnGroup {
  type: "user" | "assistant";
  timestamp?: string;
  scenes: { scene: Scene; index: number }[];
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export default function ConversationView({
  scenes,
  visibleCount,
  currentIndex,
  viewPrefs,
}: Props) {
  const visible = scenes.slice(0, visibleCount);

  const groups = useMemo(() => {
    const result: TurnGroup[] = [];
    let current: TurnGroup | null = null;

    for (let i = 0; i < visible.length; i++) {
      const scene = visible[i];
      if (viewPrefs.promptsOnly && scene.type !== "user-prompt") continue;
      if (viewPrefs.hideThinking && scene.type === "thinking") continue;

      if (scene.type === "user-prompt") {
        if (current) result.push(current);
        current = {
          type: "user",
          timestamp: scene.timestamp,
          scenes: [{ scene, index: i }],
        };
        result.push(current);
        current = null;
      } else {
        if (!current || current.type !== "assistant") {
          if (current) result.push(current);
          current = {
            type: "assistant",
            timestamp: scene.timestamp,
            scenes: [],
          };
        }
        current.scenes.push({ scene, index: i });
      }
    }
    if (current && current.scenes.length > 0) result.push(current);
    return result;
  }, [visible, viewPrefs]);

  return (
    <div className="max-w-4xl mx-auto space-y-3 pb-4">
      {groups.map((group, gi) => {
        const groupHasCurrent = group.scenes.some(({ index }) => index === currentIndex);

        return (
          <div key={gi}>
            {group.type === "user" ? (
              <div
                data-scene-index={group.scenes[0]?.index}
                className={`rounded-lg px-4 py-3 transition-colors duration-200 ${
                  groupHasCurrent
                    ? "bg-terminal-green/10 border-2 border-terminal-green/30 shadow-sm shadow-terminal-green/5"
                    : "bg-terminal-green/5 border border-terminal-green/15"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-mono font-semibold text-terminal-green uppercase tracking-wider">
                    You
                  </span>
                  {group.timestamp && (
                    <span className="text-[11px] font-mono text-terminal-dim">
                      {formatTime(group.timestamp)}
                    </span>
                  )}
                </div>
                {group.scenes.map(({ scene, index }) => (
                  <div
                    key={index}
                    className="scene-enter"
                  >
                    <SceneBlock
                      scene={scene}
                      isActive={index === currentIndex}
                      collapseTools={viewPrefs.collapseAllTools}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div
                data-scene-index={group.scenes[0]?.index}
                className={`rounded-lg px-4 py-3 transition-colors duration-200 ${
                  groupHasCurrent
                    ? "bg-terminal-blue/[0.06] border-2 border-terminal-blue/20 shadow-sm shadow-terminal-blue/5"
                    : "bg-terminal-blue/[0.03] border border-terminal-blue/10"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] font-mono font-semibold text-terminal-blue/70 uppercase tracking-wider">
                    Assistant
                  </span>
                  {group.timestamp && (
                    <span className="text-[11px] font-mono text-terminal-dim">
                      {formatTime(group.timestamp)}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <BatchedScenes
                    scenes={group.scenes}
                    currentIndex={currentIndex}
                    collapseTools={viewPrefs.collapseAllTools}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Batch consecutive tool calls of the same type into a collapsible group.
 * e.g. 27x Read → "Read 27 files" that expands on click.
 */
function BatchedScenes({
  scenes,
  currentIndex,
  collapseTools,
}: {
  scenes: { scene: Scene; index: number }[];
  currentIndex: number;
  collapseTools: boolean;
}) {
  // Group consecutive tool calls with the same toolName (only batchable ones)
  const batches: { scene: Scene; index: number }[][] = [];
  let currentBatch: { scene: Scene; index: number }[] = [];

  for (const item of scenes) {
    const prev = currentBatch[currentBatch.length - 1];
    if (
      prev &&
      prev.scene.type === "tool-call" &&
      item.scene.type === "tool-call" &&
      prev.scene.toolName === item.scene.toolName &&
      !item.scene.diff && !item.scene.bashOutput &&
      !prev.scene.diff && !prev.scene.bashOutput
    ) {
      currentBatch.push(item);
    } else {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [item];
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  return (
    <>
      {batches.map((batch) => {
        // Single item or non-batchable
        if (batch.length <= 1) {
          const { scene, index } = batch[0];
          return (
            <div
              key={index}
              data-scene-index={index}
              className={`scene-enter ${index === currentIndex ? "" : "opacity-90"}`}
            >
              <SceneBlock
                scene={scene}
                isActive={index === currentIndex}
                collapseTools={collapseTools}
              />
            </div>
          );
        }

        // Batched tool calls — always collapsed, click to expand
        const toolName = (batch[0].scene as Extract<Scene, { type: "tool-call" }>).toolName;

        return (
          <ToolBatch
            key={batch[0].index}
            batch={batch}
            toolName={toolName}
            currentIndex={currentIndex}
            collapseTools={collapseTools}
          />
        );
      })}
    </>
  );
}

function ToolBatch({
  batch,
  toolName,
  currentIndex,
  collapseTools,
}: {
  batch: { scene: Scene; index: number }[];
  toolName: string;
  currentIndex: number;
  collapseTools: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // Collapsed view: always show summary
  const summaries = batch.map(({ scene }) => {
    if (scene.type === "tool-call") {
      return summarizeToolInput(scene.toolName, scene.input);
    }
    return "";
  });

  return (
    <div data-scene-index={batch[0].index}>
      {/* Collapsed summary — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono text-terminal-dim border border-terminal-border/50 rounded-lg bg-terminal-surface/50 hover:bg-terminal-surface hover:border-terminal-border transition-colors cursor-pointer text-left"
      >
        <span className={`transition-transform text-[10px] ${expanded ? "rotate-90" : ""}`}>
          {"\u25B6"}
        </span>
        <span className="text-terminal-orange font-semibold">{toolName}</span>
        <span className="text-terminal-dim/70">{batch.length} call{batch.length > 1 ? "s" : ""}</span>
        {!expanded && (
          <span className="truncate text-terminal-dim/50 ml-1">
            {summaries.filter(Boolean).slice(0, 3).join(", ")}
            {summaries.filter(Boolean).length > 3 && "..."}
          </span>
        )}
      </button>

      {/* Expanded: show all individual tool calls */}
      {expanded && (
        <div className="mt-1 ml-4 space-y-2 border-l border-terminal-border/30 pl-3">
          {batch.map(({ scene, index }) => (
            <div
              key={index}
              data-scene-index={index}
              className={`scene-enter ${index === currentIndex ? "" : "opacity-90"}`}
            >
              <SceneBlock
                scene={scene}
                isActive={index === currentIndex}
                collapseTools={collapseTools}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeToolInput(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read": return input.file_path || "";
    case "Glob": return input.pattern || "";
    case "Grep": return input.pattern || "";
    case "Agent": return input.description || "";
    default: return "";
  }
}

function SceneBlock({
  scene,
  isActive,
  collapseTools,
}: {
  scene: Scene;
  isActive: boolean;
  collapseTools: boolean;
}) {
  switch (scene.type) {
    case "user-prompt":
      return (
        <UserPromptBlock
          content={scene.content}
          images={scene.images}
          isActive={isActive}
        />
      );
    case "thinking":
      return <ThinkingBlock content={scene.content} isActive={isActive} />;
    case "text-response":
      return <TextResponseBlock content={scene.content} isActive={isActive} />;
    case "tool-call":
      return (
        <ToolCallBlock
          scene={scene}
          isActive={isActive}
          forceCollapse={collapseTools}
        />
      );
  }
}
