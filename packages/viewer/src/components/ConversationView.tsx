import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { EffectivePrefs } from "../hooks/useViewPrefs";
import type { Scene } from "../types";
import CompactionSummaryBlock from "./CompactionSummaryBlock";
import TextResponseBlock from "./TextResponseBlock";
import ThinkingBlock from "./ThinkingBlock";
import ToolCallBlock from "./ToolCallBlock";
import UserPromptBlock from "./UserPromptBlock";

interface Props {
  scenes: Scene[];
  visibleCount: number;
  currentIndex: number;
  effectivePrefs: EffectivePrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
  state?: string;
}

interface TurnGroup {
  type: "user" | "assistant" | "compaction";
  timestamp?: string;
  scenes: { scene: Scene; index: number }[];
  turnNumber?: number;
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
  effectivePrefs,
  focusIndex,
  annotatedScenes,
  annotationCounts,
  onComment,
  onSeek,
  state,
}: Props & { onSeek?: (index: number) => void }) {
  // Pre-compute ALL groups once — stable across playback ticks
  const allGroups = useMemo(() => {
    const result: TurnGroup[] = [];
    let current: TurnGroup | null = null;
    let turnCount = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (scene.type === "user-prompt" || scene.type === "compaction-summary") {
        if (current && current.scenes.length > 0) result.push(current);
        const type = scene.type === "compaction-summary" ? "compaction" : "user";
        if (type === "user") turnCount++;
        result.push({
          type,
          timestamp: scene.timestamp,
          scenes: [{ scene, index: i }],
          turnNumber: type === "user" ? turnCount : undefined,
        } as TurnGroup);
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

  // Only show groups that have visible scenes, filtered by effectivePrefs
  const displayGroups = useMemo(() => {
    if (effectivePrefs.promptsOnly) {
      return allGroups.filter(
        (g) => (g.type === "user" || g.type === "compaction") && g.scenes[0].index < visibleCount,
      );
    }
    return allGroups.filter((g) => g.scenes[0].index < visibleCount);
  }, [allGroups, visibleCount, effectivePrefs.promptsOnly]);

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
    <div className="max-w-4xl mx-auto space-y-5 pb-6">
      {displayGroups.map((group, gi) => (
        <LazyGroup key={gi} forceRender={Math.abs(gi - currentGroupIdx) <= 5}>
          <GroupCard
            group={group}
            currentIndex={currentIndex}
            visibleCount={visibleCount}
            effectivePrefs={effectivePrefs}
            focusIndex={focusIndex}
            annotatedScenes={annotatedScenes}
            annotationCounts={annotationCounts}
            onComment={onComment}
          />
        </LazyGroup>
      ))}
      {state === "paused" && visibleCount < scenes.length && (
        <div className="pt-4 pb-12 flex items-center justify-center animate-in fade-in slide-in-from-bottom-2 duration-700 ease-out select-none">
          <div className="group/pause relative flex items-center gap-8 px-4 py-2 bg-transparent backdrop-blur-sm">
            {/* Ambient Glow */}
            <div className="absolute inset-0 bg-terminal-orange/5 opacity-0 group-hover/pause:opacity-100 transition-opacity duration-700 blur-2xl -z-10" />

            {/* Left: Status Label */}
            <div className="flex items-center gap-2.5 pr-8 border-r border-terminal-border/20">
              <div className="relative flex h-2 w-2">
                <div className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminal-orange opacity-40"></div>
                <div className="relative inline-flex rounded-full h-2 w-2 bg-terminal-orange/80 shadow-[0_0_8px_rgba(251,146,60,0.5)]"></div>
              </div>
              <span className="text-[10px] font-sans font-black text-terminal-orange uppercase tracking-[.25em] drop-shadow-sm">
                Paused
              </span>
            </div>

            {/* Right: Interaction Hints */}
            <div className="flex items-center gap-8">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-terminal-surface-hover/80 border border-terminal-border-subtle/50 text-terminal-text shadow-sm">
                  <span className="text-[11px] font-mono font-bold">&darr;</span>
                </div>
                <span className="text-[10px] font-sans font-bold text-terminal-dim uppercase tracking-widest opacity-80">
                  Explore
                </span>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-terminal-surface-hover/80 border border-terminal-border-subtle/50 text-terminal-text shadow-sm">
                  <span className="text-[9px] font-mono font-black tracking-tight">SPACE</span>
                </div>
                <span className="text-[10px] font-sans font-bold text-terminal-dim uppercase tracking-widest opacity-80">
                  Resume
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {visibleCount >= scenes.length && (
        <div className="pt-12 pb-24 flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-1000 ease-out select-none">
          <div className="h-px w-8 bg-terminal-border-subtle mb-6" />
          <div className="flex flex-col items-center gap-1">
            <div className="text-[10px] font-mono font-bold text-terminal-dimmer uppercase tracking-[0.3em]">
              the end
            </div>
            <div className="text-[9px] font-mono text-terminal-border uppercase tracking-widest mt-1">
              session replay complete
            </div>
          </div>

          <div className="mt-8 flex flex-col items-center gap-6">
            <button
              onClick={() => onSeek?.(0)}
              className="group flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-terminal-surface/30 border border-terminal-border-subtle text-terminal-dimmer hover:text-terminal-green hover:border-terminal-green/30 hover:bg-terminal-green/5 transition-all duration-300"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform duration-300 group-hover:-translate-y-0.5"
              >
                <path d="m18 15-6-6-6 6" />
              </svg>
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest transition-colors">
                Back to Top
              </span>
              <span className="text-[9px] font-mono font-bold opacity-0 group-hover:opacity-60 transition-opacity">
                {" "}
                [Home]
              </span>
            </button>

            <div className="flex items-center gap-3 opacity-20">
              <div className="w-1 h-1 rounded-full bg-terminal-green" />
              <div className="w-1 h-1 rounded-full bg-terminal-blue" />
              <div className="w-1 h-1 rounded-full bg-terminal-orange" />
            </div>
          </div>
        </div>
      )}
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
      style={!shouldRender && heightRef.current > 0 ? { minHeight: heightRef.current } : undefined}
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
  effectivePrefs,
  focusIndex,
  annotatedScenes: _annotatedScenes,
  annotationCounts,
  onComment,
}: {
  group: TurnGroup;
  currentIndex: number;
  visibleCount: number;
  effectivePrefs: EffectivePrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
  state?: string;
}) {
  const [hovered, setHovered] = useState(false);

  // Only include scenes that are visible so far
  const visibleScenes = useMemo(
    () => group.scenes.filter((s) => s.index < visibleCount),
    [group.scenes, visibleCount],
  );

  const groupHasCurrent = visibleScenes.some(({ index }) => index === currentIndex);
  const groupHasFocusedTarget =
    typeof focusIndex === "number" && visibleScenes.some(({ index }) => index === focusIndex);
  const firstIndex = visibleScenes[0]?.index;

  if (visibleScenes.length === 0) return null;

  // User groups get a group-level comment button (single scene)
  const userCommentCount = group.type === "user" ? annotationCounts?.get(firstIndex) || 0 : 0;
  const userCommentButton =
    group.type === "user" && onComment && (userCommentCount > 0 || hovered) ? (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onComment(firstIndex);
        }}
        className={`absolute right-0 top-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-md text-xs font-mono transition-all duration-150 ${
          userCommentCount > 0
            ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
            : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover:opacity-100"
        }`}
        title={
          userCommentCount > 0
            ? `${userCommentCount} comment${userCommentCount > 1 ? "s" : ""}`
            : "Add comment"
        }
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
        className={`group relative rounded-2xl px-5 py-4 transition-all duration-200 ease-material ml-4 md:ml-12 border ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-green-emphasis border-terminal-green shadow-layer-lg"
            : groupHasCurrent
              ? "bg-terminal-green-subtle border-terminal-green/30 shadow-layer-sm"
              : "bg-terminal-surface border-terminal-border-subtle shadow-sm"
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {userCommentButton}
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-[10px] font-sans font-semibold text-terminal-green uppercase tracking-widest">
            You
          </span>
          {group.timestamp && (
            <span className="text-[10px] font-mono text-terminal-dimmer">
              {formatTime(group.timestamp)}
            </span>
          )}
          <div className="flex-1" />
          {groupHasFocusedTarget ? (
            <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-green text-terminal-bg">
              Jump Target
            </span>
          ) : (
            groupHasCurrent && (
              <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-green-subtle text-terminal-green border border-terminal-green/20">
                Focused
              </span>
            )
          )}
          {group.turnNumber !== undefined && (
            <span className="text-[10px] font-mono text-terminal-dimmer font-bold">
              #{String(group.turnNumber).padStart(2, "0")}
            </span>
          )}
        </div>
        <div className="text-left">
          {visibleScenes.map(({ scene, index }) => (
            <div key={index} className="scene-enter">
              <SceneBlock
                scene={scene}
                isActive={index === currentIndex}
                collapseTools={effectivePrefs.collapseAllTools}
              />
            </div>
          ))}
        </div>
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
        className={`group relative rounded-xl px-5 py-3.5 transition-all duration-200 ease-material ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-surface border-l-2 border-terminal-dim shadow-layer-sm"
            : groupHasCurrent
              ? "bg-terminal-surface border-l-2 border-terminal-dim shadow-layer-sm"
              : "bg-terminal-surface/50"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-sans font-semibold text-terminal-dim uppercase tracking-widest">
            Context Compaction
          </span>
          {group.timestamp && (
            <span className="text-xs font-mono text-terminal-dimmer">
              {formatTime(group.timestamp)}
            </span>
          )}
        </div>
        <CompactionSummaryBlock content={scene.content} isActive={firstIndex === currentIndex} />
      </div>
    );
  }

  // Assistant group — filter by effectivePrefs
  const filteredScenes = effectivePrefs.hideThinking
    ? visibleScenes.filter((s) => s.scene.type !== "thinking")
    : visibleScenes;

  if (filteredScenes.length === 0) return null;

  // All scenes in the group (unfiltered by visibleCount) — for stable stats
  const allGroupScenes = effectivePrefs.hideThinking
    ? group.scenes.filter((s) => s.scene.type !== "thinking")
    : group.scenes;

  // Compact mode: show summary + last text-response, expandable
  if (effectivePrefs.compactAssistant) {
    return (
      <CompactAssistantGroup
        allScenes={allGroupScenes}
        filteredScenes={filteredScenes}
        firstIndex={firstIndex}
        currentIndex={currentIndex}
        groupHasCurrent={groupHasCurrent}
        groupHasFocusedTarget={groupHasFocusedTarget}
        timestamp={group.timestamp}
        annotationCounts={annotationCounts}
        onComment={onComment}
      />
    );
  }

  return (
    <div
      id={`scene-${firstIndex}`}
      data-scene-index={firstIndex}
      className={`relative rounded-xl px-5 py-4 transition-all duration-200 ease-material ${
        groupHasFocusedTarget
          ? "scene-nav-focused bg-terminal-blue-subtle border-l-2 border-terminal-blue shadow-layer-lg"
          : groupHasCurrent
            ? "bg-terminal-blue-subtle border-l-2 border-terminal-blue shadow-layer-sm"
            : "bg-terminal-surface shadow-layer-sm"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-sans font-semibold text-terminal-blue uppercase tracking-widest">
          Assistant
        </span>
        {group.timestamp && (
          <span className="text-[10px] font-mono text-terminal-dimmer">
            {formatTime(group.timestamp)}
          </span>
        )}
        <div className="flex-1" />
        {groupHasFocusedTarget ? (
          <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-blue-emphasis text-terminal-blue">
            Jump Target
          </span>
        ) : (
          groupHasCurrent && (
            <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-blue-subtle text-terminal-blue">
              Focused
            </span>
          )
        )}
        {group.turnNumber !== undefined && (
          <span className="text-[10px] font-mono text-terminal-dimmer font-bold">
            #{String(group.turnNumber).padStart(2, "0")}
          </span>
        )}
      </div>
      <div className="space-y-2">
        <BatchedScenes
          scenes={filteredScenes}
          currentIndex={currentIndex}
          collapseTools={effectivePrefs.collapseAllTools}
          annotationCounts={annotationCounts}
          onComment={onComment}
        />
      </div>
    </div>
  );
});

/** Shorten long MCP-style tool names: mcp__service__method → method */
function shortToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1];
  }
  return name;
}

/**
 * Compact assistant group: shows a STABLE summary (computed from ALL scenes
 * in the group, not just visible ones) plus the last text-response preview.
 */
function CompactAssistantGroup({
  allScenes,
  filteredScenes,
  firstIndex,
  currentIndex,
  groupHasCurrent,
  groupHasFocusedTarget,
  timestamp,
  annotationCounts,
  onComment,
}: {
  /** All scenes in the group — used for stable stats (not affected by playback progress) */
  allScenes: { scene: Scene; index: number }[];
  /** Scenes visible so far (filtered by visibleCount + prefs) — used for expand view */
  filteredScenes: { scene: Scene; index: number }[];
  firstIndex: number;
  currentIndex: number;
  groupHasCurrent: boolean;
  groupHasFocusedTarget: boolean;
  timestamp?: string;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      if (!groupHasCurrent) return;
      const detail = (e as CustomEvent).detail;
      if (detail.action === "expand") setExpanded(true);
      else if (detail.action === "collapse") setExpanded(false);
    };
    window.addEventListener("vibe:toggle-expand", handler);
    return () => window.removeEventListener("vibe:toggle-expand", handler);
  }, [groupHasCurrent]);

  // Compute stats from ALL scenes (stable — doesn't change during playback)
  const stats = useMemo(() => {
    const toolBreakdown: Record<string, number> = {};
    const bashCommands = new Set<string>();
    let responses = 0;
    let thinking = 0;
    let totalTools = 0;
    for (const { scene } of allScenes) {
      if (scene.type === "tool-call") {
        totalTools++;
        const displayName = shortToolName(scene.toolName);
        toolBreakdown[displayName] = (toolBreakdown[displayName] || 0) + 1;
        if (scene.toolName === "Bash" && scene.input?.command) {
          const cmd = scene.input.command.trim().split(/[\s|;&]/)[0];
          if (cmd) bashCommands.add(cmd);
        }
      } else if (scene.type === "text-response") responses++;
      else if (scene.type === "thinking") thinking++;
    }
    return { totalTools, toolBreakdown, responses, thinking, bashCommands: [...bashCommands] };
  }, [allScenes]);

  // Find the last text-response from ALL scenes (stable preview)
  const lastTextResponse = useMemo(() => {
    for (let i = allScenes.length - 1; i >= 0; i--) {
      if (allScenes[i].scene.type === "text-response") {
        return allScenes[i];
      }
    }
    return null;
  }, [allScenes]);

  // Ordered tool names for display (common ones first)
  const sortedToolEntries = useMemo(() => {
    const order = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"];
    const entries = Object.entries(stats.toolBreakdown);
    entries.sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      const ao = ai >= 0 ? ai : 100;
      const bo = bi >= 0 ? bi : 100;
      return ao - bo;
    });
    return entries;
  }, [stats.toolBreakdown]);

  // Total comment count across all scenes in this group
  const groupCommentCount = useMemo(
    () =>
      annotationCounts
        ? allScenes.reduce((sum, { index }) => sum + (annotationCounts.get(index) || 0), 0)
        : 0,
    [allScenes, annotationCounts],
  );

  const [hovered, setHovered] = useState(false);

  return (
    <div
      id={`scene-${firstIndex}`}
      data-scene-index={firstIndex}
      className={`group relative rounded-xl px-5 py-4 transition-all duration-200 ease-material ${
        groupHasFocusedTarget
          ? "scene-nav-focused bg-terminal-blue-subtle border-l-2 border-terminal-blue shadow-layer-lg"
          : groupHasCurrent
            ? "bg-terminal-blue-subtle border-l-2 border-terminal-blue shadow-layer-sm"
            : "bg-terminal-surface shadow-layer-sm"
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Group-level comment button */}
      {onComment && (groupCommentCount > 0 || hovered) && !expanded && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onComment(firstIndex);
          }}
          className={`absolute right-3 top-3 z-10 flex items-center gap-1 px-1.5 py-1 rounded-md text-xs font-mono transition-all duration-150 ${
            groupCommentCount > 0
              ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
              : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover:opacity-100"
          }`}
          title={
            groupCommentCount > 0
              ? `${groupCommentCount} comment${groupCommentCount > 1 ? "s" : ""}`
              : "Add comment"
          }
        >
          {"\uD83D\uDCAC"}
          {groupCommentCount > 0 && <span>{groupCommentCount}</span>}
        </button>
      )}

      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-sans font-semibold text-terminal-blue uppercase tracking-widest">
          Assistant
        </span>
        {timestamp && (
          <span className="text-[10px] font-mono text-terminal-dimmer">
            {formatTime(timestamp)}
          </span>
        )}
        <div className="flex-1" />
        {groupHasFocusedTarget ? (
          <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-blue-emphasis text-terminal-blue">
            Jump Target
          </span>
        ) : (
          groupHasCurrent && (
            <span className="text-[10px] font-sans font-medium uppercase tracking-widest px-2 py-0.5 rounded-full bg-terminal-blue-subtle text-terminal-blue">
              Focused
            </span>
          )
        )}
      </div>

      {/* Compact stats bar — stable, computed from ALL scenes */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[11px] font-mono">
        {stats.responses > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-blue-subtle text-terminal-blue">
            {stats.responses} response{stats.responses > 1 ? "s" : ""}
          </span>
        )}
        {stats.totalTools > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-orange-subtle text-terminal-orange">
            {stats.totalTools} tool{stats.totalTools > 1 ? "s" : ""}
          </span>
        )}
        {stats.thinking > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-purple-subtle text-terminal-purple">
            {stats.thinking} thinking
          </span>
        )}
        {sortedToolEntries.length > 0 && (
          <>
            <span className="text-terminal-border mx-0.5">|</span>
            {sortedToolEntries.map(([name, count]) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-terminal-surface-hover text-terminal-dim"
              >
                <span className="text-terminal-orange">{name}</span>
                {name === "Bash" && stats.bashCommands.length > 0 && (
                  <span className="text-terminal-dimmer">
                    ({stats.bashCommands.slice(0, 4).join(", ")}
                    {stats.bashCommands.length > 4 ? ", ..." : ""})
                  </span>
                )}
                <span>{count}</span>
              </span>
            ))}
          </>
        )}
      </div>

      {/* Last text-response preview (stable — from all scenes) */}
      {lastTextResponse && !expanded && (
        <div className="mb-2">
          <TextResponseBlock
            content={(lastTextResponse.scene as Extract<Scene, { type: "text-response" }>).content}
            isActive={lastTextResponse.index === currentIndex}
          />
        </div>
      )}

      {/* Expanded: show visible scenes so far with per-scene comment buttons */}
      {expanded && (
        <div className="space-y-2 mb-2">
          {filteredScenes.map(({ scene, index }) => {
            const count = annotationCounts?.get(index) || 0;
            return (
              <div
                key={index}
                data-scene-index={index}
                className={`group/scene relative scene-enter ${onComment ? "pr-7" : ""}`}
              >
                <SceneBlock scene={scene} isActive={index === currentIndex} collapseTools={false} />
                {onComment && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onComment(index);
                    }}
                    className={`absolute right-0 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
                      count > 0
                        ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
                        : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover/scene:opacity-100"
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

      {/* Expand/collapse toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs font-mono text-terminal-dim hover:text-terminal-blue transition-colors flex items-center gap-1.5"
      >
        {groupHasCurrent && (
          <span className="text-secondary-text font-bold opacity-70">
            {expanded ? "[←]" : "[→]"}
          </span>
        )}
        <span>{expanded ? "Collapse" : "Show all details"}</span>
      </button>
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
  annotationCounts,
  onComment,
}: {
  scenes: { scene: Scene; index: number }[];
  currentIndex: number;
  collapseTools: boolean;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
  state?: string;
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
      !item.scene.diff &&
      !item.scene.bashOutput &&
      !prev.scene.diff &&
      !prev.scene.bashOutput
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
              className={`group/scene relative scene-enter ${onComment ? "pr-7" : ""}`}
            >
              <SceneBlock
                scene={scene}
                isActive={index === currentIndex}
                collapseTools={collapseTools}
              />
              {onComment && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onComment(index);
                  }}
                  className={`absolute right-0 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
                    count > 0
                      ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
                      : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover/scene:opacity-100"
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
  state?: string;
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
    <div
      data-scene-index={batch[0].index}
      className={`group/batch relative ${onComment ? "pr-7" : ""}`}
    >
      {/* Collapsed summary */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-xs font-mono text-terminal-dim rounded-xl bg-terminal-surface hover:bg-terminal-surface-hover transition-all duration-200 ease-material cursor-pointer text-left shadow-layer-sm"
      >
        <span className={`transition-transform text-xs ${expanded ? "rotate-90" : ""}`}>
          {"\u25B6"}
        </span>
        <span className="text-terminal-orange font-semibold">{toolName}</span>
        <span className="text-terminal-dimmer">
          {batch.length} call{batch.length > 1 ? "s" : ""}
        </span>
        {!expanded && (
          <span className="truncate text-terminal-dimmer ml-1">
            {summaries.filter(Boolean).slice(0, 3).join(", ")}
            {summaries.filter(Boolean).length > 3 && "..."}
          </span>
        )}
      </button>
      {/* Batch-level comment button (visible when collapsed) */}
      {onComment && !expanded && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onComment(batch[0].index);
          }}
          className={`absolute right-0 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
            batchCommentCount > 0
              ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
              : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover/batch:opacity-100"
          }`}
          title={
            batchCommentCount > 0
              ? `${batchCommentCount} comment${batchCommentCount > 1 ? "s" : ""}`
              : "Add comment"
          }
        >
          {"\uD83D\uDCAC"}
          {batchCommentCount > 0 && <span>{batchCommentCount}</span>}
        </button>
      )}

      {/* Expanded: show all individual tool calls with per-scene comment buttons */}
      {expanded && (
        <div className="mt-1 ml-4 space-y-2 pl-4">
          {batch.map(({ scene, index }) => {
            const count = annotationCounts?.get(index) || 0;
            return (
              <div
                key={index}
                data-scene-index={index}
                className={`group/scene relative scene-enter ${onComment ? "pr-7" : ""}`}
              >
                <SceneBlock
                  scene={scene}
                  isActive={index === currentIndex}
                  collapseTools={collapseTools}
                />
                {onComment && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onComment(index);
                    }}
                    className={`absolute right-0 top-1 z-10 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
                      count > 0
                        ? "bg-terminal-blue text-terminal-bg shadow-layer-sm"
                        : "text-terminal-dim hover:text-terminal-blue hover:bg-terminal-blue-subtle opacity-0 group-hover/scene:opacity-100"
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
    case "Read":
      return input.file_path || "";
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return input.pattern || "";
    case "Agent":
      return input.description || "";
    default:
      return "";
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
      return <UserPromptBlock content={scene.content} images={scene.images} isActive={isActive} />;
    case "compaction-summary":
      return <CompactionSummaryBlock content={scene.content} isActive={isActive} />;
    case "thinking":
      return <ThinkingBlock content={scene.content} isActive={isActive} />;
    case "text-response":
      return <TextResponseBlock content={scene.content} isActive={isActive} />;
    case "tool-call":
      return <ToolCallBlock scene={scene} isActive={isActive} forceCollapse={collapseTools} />;
  }
});
