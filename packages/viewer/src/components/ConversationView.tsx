import { useMemo, useState, useRef, useEffect, memo } from "react";
import type { Scene } from "../types";
import type { ViewPrefs } from "../hooks/useViewPrefs";
import UserPromptBlock from "./UserPromptBlock";
import CompactionSummaryBlock from "./CompactionSummaryBlock";
import ThinkingBlock from "./ThinkingBlock";
import TextResponseBlock from "./TextResponseBlock";
import ToolCallBlock from "./ToolCallBlock";

interface Props {
  scenes: Scene[];
  visibleCount: number;
  currentIndex: number;
  viewPrefs: ViewPrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
}

interface TurnGroup {
  type: "user" | "assistant" | "compaction";
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
  focusIndex,
  annotatedScenes,
  annotationCounts,
  onComment,
}: Props) {
  // Pre-compute ALL groups once — stable across playback ticks
  const allGroups = useMemo(() => {
    const result: TurnGroup[] = [];
    let current: TurnGroup | null = null;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (scene.type === "user-prompt" || scene.type === "compaction-summary") {
        if (current && current.scenes.length > 0) result.push(current);
        result.push({
          type: scene.type === "compaction-summary" ? "compaction" : "user",
          timestamp: scene.timestamp,
          scenes: [{ scene, index: i }],
        });
        current = null;
      } else {
        if (!current || current.type !== "assistant") {
          if (current && current.scenes.length > 0) result.push(current);
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
  }, [scenes]);

  // Only show groups that have visible scenes, filtered by viewPrefs
  const displayGroups = useMemo(() => {
    if (viewPrefs.promptsOnly) {
      return allGroups
        .filter(
          (g) =>
            (g.type === "user" || g.type === "compaction") && g.scenes[0].index < visibleCount,
        );
    }
    return allGroups.filter((g) => g.scenes[0].index < visibleCount);
  }, [allGroups, visibleCount, viewPrefs.promptsOnly]);

  // Find which group contains the currentIndex
  const currentGroupIdx = useMemo(() => {
    for (let i = displayGroups.length - 1; i >= 0; i--) {
      if (displayGroups[i].scenes.some((s) => s.index <= currentIndex)) {
        return i;
      }
    }
    return displayGroups.length - 1;
  }, [displayGroups, currentIndex]);

  return (
    <div className="max-w-4xl mx-auto space-y-3 pb-4">
      {displayGroups.map((group, gi) => (
        <LazyGroup
          key={gi}
          forceRender={Math.abs(gi - currentGroupIdx) <= 5}
        >
          <GroupCard
            group={group}
            currentIndex={currentIndex}
            visibleCount={visibleCount}
            viewPrefs={viewPrefs}
            focusIndex={focusIndex}
            annotatedScenes={annotatedScenes}
            annotationCounts={annotationCounts}
            onComment={onComment}
          />
        </LazyGroup>
      ))}
    </div>
  );
}

/**
 * IntersectionObserver-based lazy renderer.
 * Only mounts children when near the viewport or forceRender is true.
 */
const LazyGroup = memo(function LazyGroup({
  children,
  forceRender,
}: {
  children: React.ReactNode;
  forceRender: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const heightRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        setInView(e.isIntersecting);
        if (e.isIntersecting && el.offsetHeight > 0) {
          heightRef.current = el.offsetHeight;
        }
      },
      { rootMargin: "800px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const shouldRender = inView || forceRender;

  // Cache height when rendered
  useEffect(() => {
    if (shouldRender && ref.current && ref.current.offsetHeight > 0) {
      heightRef.current = ref.current.offsetHeight;
    }
  });

  return (
    <div
      ref={ref}
      style={
        !shouldRender && heightRef.current > 0
          ? { minHeight: heightRef.current }
          : undefined
      }
    >
      {shouldRender ? children : null}
    </div>
  );
});

/**
 * Renders a single user or assistant group card.
 */
const GroupCard = memo(function GroupCard({
  group,
  currentIndex,
  visibleCount,
  viewPrefs,
  focusIndex,
  annotatedScenes,
  annotationCounts,
  onComment,
}: {
  group: TurnGroup;
  currentIndex: number;
  visibleCount: number;
  viewPrefs: ViewPrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
}) {
  const [hovered, setHovered] = useState(false);

  // Only include scenes that are visible so far
  const visibleScenes = useMemo(
    () => group.scenes.filter((s) => s.index < visibleCount),
    [group.scenes, visibleCount],
  );

  const groupHasCurrent = visibleScenes.some(({ index }) => index === currentIndex);
  const groupHasFocusedTarget =
    typeof focusIndex === "number" &&
    visibleScenes.some(({ index }) => index === focusIndex);
  const firstIndex = visibleScenes[0]?.index;

  if (visibleScenes.length === 0) return null;

  // User groups get a group-level comment button (single scene)
  const userCommentCount = group.type === "user" ? (annotationCounts?.get(firstIndex) || 0) : 0;
  const userCommentButton = group.type === "user" && onComment && (userCommentCount > 0 || hovered) ? (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onComment(firstIndex);
      }}
      className={`absolute -right-3 top-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-md border text-[10px] font-mono transition-all duration-150 ${
        userCommentCount > 0
          ? "bg-terminal-blue border-terminal-blue text-white shadow-sm"
          : "bg-terminal-bg border-terminal-border text-terminal-dim hover:text-terminal-blue hover:border-terminal-blue/40 opacity-0 group-hover:opacity-100"
      }`}
      title={userCommentCount > 0 ? `${userCommentCount} comment${userCommentCount > 1 ? "s" : ""}` : "Add comment"}
    >
      {"\uD83D\uDCAC"}
      {userCommentCount > 0 && <span>{userCommentCount}</span>}
    </button>
  ) : null;

  if (group.type === "user") {
    return (
      <div
        id={`scene-${firstIndex}`}
        data-scene-index={firstIndex}
        className={`group relative rounded-lg px-4 py-3 transition-colors duration-200 ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-green/30 border-2 border-terminal-green ring-2 ring-terminal-green/60 shadow-lg shadow-terminal-green/30"
            : groupHasCurrent
              ? "bg-terminal-green/20 border-2 border-terminal-green/60 ring-1 ring-terminal-green/40 shadow-md shadow-terminal-green/20"
              : "bg-terminal-green/5 border border-terminal-green/15"
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {userCommentButton}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] font-mono font-semibold text-terminal-green uppercase tracking-wider">
            You
          </span>
          {groupHasFocusedTarget ? (
            <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-terminal-green text-terminal-green bg-terminal-green/20">
              Jump Target
            </span>
          ) : groupHasCurrent && (
            <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-terminal-green/50 text-terminal-green bg-terminal-green/10">
              Focused
            </span>
          )}
          {group.timestamp && (
            <span className="text-[11px] font-mono text-terminal-dim">
              {formatTime(group.timestamp)}
            </span>
          )}
        </div>
        {visibleScenes.map(({ scene, index }) => (
          <div key={index} className="scene-enter">
            <SceneBlock
              scene={scene}
              isActive={index === currentIndex}
              collapseTools={viewPrefs.collapseAllTools}
            />
          </div>
        ))}
      </div>
    );
  }

  if (group.type === "compaction") {
    const scene = visibleScenes[0]?.scene;
    if (!scene || scene.type !== "compaction-summary") return null;
    return (
      <div
        id={`scene-${firstIndex}`}
        data-scene-index={firstIndex}
        className={`group relative rounded-lg px-4 py-3 transition-colors duration-200 ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-dim/20 border-2 border-terminal-dim ring-2 ring-terminal-dim/60"
            : groupHasCurrent
              ? "bg-terminal-dim/10 border-2 border-terminal-dim/40"
              : "bg-terminal-dim/[0.03] border border-terminal-border/30 border-dashed"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] font-mono font-semibold text-terminal-dim uppercase tracking-wider">
            Context Compaction
          </span>
          {group.timestamp && (
            <span className="text-[11px] font-mono text-terminal-dim/60">
              {formatTime(group.timestamp)}
            </span>
          )}
        </div>
        <CompactionSummaryBlock content={scene.content} isActive={firstIndex === currentIndex} />
      </div>
    );
  }

  // Assistant group — filter by viewPrefs
  const filteredScenes = viewPrefs.hideThinking
    ? visibleScenes.filter((s) => s.scene.type !== "thinking")
    : visibleScenes;

  if (filteredScenes.length === 0) return null;

  return (
    <div
      id={`scene-${firstIndex}`}
      data-scene-index={firstIndex}
      className={`relative rounded-lg px-4 py-3 transition-colors duration-200 ${
        groupHasFocusedTarget
          ? "scene-nav-focused bg-terminal-blue/20 border-2 border-terminal-blue ring-2 ring-terminal-blue/60 shadow-lg shadow-terminal-blue/30"
          : groupHasCurrent
            ? "bg-terminal-blue/15 border-2 border-terminal-blue/45 ring-1 ring-terminal-blue/35 shadow-md shadow-terminal-blue/20"
            : "bg-terminal-blue/[0.03] border border-terminal-blue/10"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-mono font-semibold text-terminal-blue/70 uppercase tracking-wider">
          Assistant
        </span>
        {groupHasFocusedTarget ? (
          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-terminal-blue text-terminal-blue bg-terminal-blue/20">
            Jump Target
          </span>
        ) : groupHasCurrent && (
          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-terminal-blue/50 text-terminal-blue bg-terminal-blue/10">
            Focused
          </span>
        )}
        {group.timestamp && (
          <span className="text-[11px] font-mono text-terminal-dim">
            {formatTime(group.timestamp)}
          </span>
        )}
      </div>
      <div className="space-y-2">
        <BatchedScenes
          scenes={filteredScenes}
          currentIndex={currentIndex}
          collapseTools={viewPrefs.collapseAllTools}
          annotationCounts={annotationCounts}
          onComment={onComment}
        />
      </div>
    </div>
  );
});

/**
 * Batch consecutive tool calls of the same type into a collapsible group.
 * e.g. 27x Read → "Read 27 files" that expands on click.
 */
function BatchedScenes({
  scenes,
  currentIndex,
  collapseTools,
  annotationCounts,
  onComment,
}: {
  scenes: { scene: Scene; index: number }[];
  currentIndex: number;
  collapseTools: boolean;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
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
          const count = annotationCounts?.get(index) || 0;
          return (
            <div
              key={index}
              data-scene-index={index}
              className={`group/scene relative scene-enter ${index === currentIndex ? "" : "opacity-90"}`}
            >
              <SceneBlock
                scene={scene}
                isActive={index === currentIndex}
                collapseTools={collapseTools}
              />
              {onComment && (
                <button
                  onClick={(e) => { e.stopPropagation(); onComment(index); }}
                  className={`absolute -right-2 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-all duration-150 ${
                    count > 0
                      ? "bg-terminal-blue border-terminal-blue text-white shadow-sm"
                      : "bg-terminal-bg border-terminal-border text-terminal-dim hover:text-terminal-blue hover:border-terminal-blue/40 opacity-0 group-hover/scene:opacity-100"
                  }`}
                  title={count > 0 ? `${count} comment${count > 1 ? "s" : ""}` : "Add comment"}
                >
                  {"\uD83D\uDCAC"}
                  {count > 0 && <span>{count}</span>}
                </button>
              )}
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
            annotationCounts={annotationCounts}
            onComment={onComment}
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
  annotationCounts,
  onComment,
}: {
  batch: { scene: Scene; index: number }[];
  toolName: string;
  currentIndex: number;
  collapseTools: boolean;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Total comment count across all items in batch
  const batchCommentCount = annotationCounts
    ? batch.reduce((sum, { index }) => sum + (annotationCounts.get(index) || 0), 0)
    : 0;

  // Collapsed view: always show summary
  const summaries = batch.map(({ scene }) => {
    if (scene.type === "tool-call") {
      return summarizeToolInput(scene.toolName, scene.input);
    }
    return "";
  });

  return (
    <div data-scene-index={batch[0].index} className="group/batch relative">
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
      {/* Batch-level comment button (visible when collapsed) */}
      {onComment && !expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); onComment(batch[0].index); }}
          className={`absolute -right-2 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-all duration-150 ${
            batchCommentCount > 0
              ? "bg-terminal-blue border-terminal-blue text-white shadow-sm"
              : "bg-terminal-bg border-terminal-border text-terminal-dim hover:text-terminal-blue hover:border-terminal-blue/40 opacity-0 group-hover/batch:opacity-100"
          }`}
          title={batchCommentCount > 0 ? `${batchCommentCount} comment${batchCommentCount > 1 ? "s" : ""}` : "Add comment"}
        >
          {"\uD83D\uDCAC"}
          {batchCommentCount > 0 && <span>{batchCommentCount}</span>}
        </button>
      )}

      {/* Expanded: show all individual tool calls with per-scene comment buttons */}
      {expanded && (
        <div className="mt-1 ml-4 space-y-2 border-l border-terminal-border/30 pl-3">
          {batch.map(({ scene, index }) => {
            const count = annotationCounts?.get(index) || 0;
            return (
              <div
                key={index}
                data-scene-index={index}
                className={`group/scene relative scene-enter ${index === currentIndex ? "" : "opacity-90"}`}
              >
                <SceneBlock
                  scene={scene}
                  isActive={index === currentIndex}
                  collapseTools={collapseTools}
                />
                {onComment && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onComment(index); }}
                    className={`absolute -right-2 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-mono transition-all duration-150 ${
                      count > 0
                        ? "bg-terminal-blue border-terminal-blue text-white shadow-sm"
                        : "bg-terminal-bg border-terminal-border text-terminal-dim hover:text-terminal-blue hover:border-terminal-blue/40 opacity-0 group-hover/scene:opacity-100"
                    }`}
                    title={count > 0 ? `${count} comment${count > 1 ? "s" : ""}` : "Add comment"}
                  >
                    {"\uD83D\uDCAC"}
                    {count > 0 && <span>{count}</span>}
                  </button>
                )}
              </div>
            );
          })}
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

const SceneBlock = memo(function SceneBlock({
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
    case "compaction-summary":
      return <CompactionSummaryBlock content={scene.content} isActive={isActive} />;
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
});
