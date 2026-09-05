import { memo, useEffect, useMemo, useRef, useState } from "react";
import { findContextDrops, getContextScale, getTurnStat } from "../engine";
import type { OverlayActions } from "../hooks/useOverlays";
import type { LiveCursorDiagnostics } from "../hooks/useSessionLoader";
import type { EffectivePrefs } from "../hooks/useViewPrefs";
import type { Annotation, Scene, TurnStat } from "../types";
import { textHighlightsByScene, type TextHighlight } from "../utils/annotation-highlights";
import { assistantSpeakerLabel, userSpeakerLabel } from "../utils/speaker-label";
import { displayToolName } from "../utils/toolName";
import CompactionSummaryBlock from "./CompactionSummaryBlock";
import { fmtNum, formatTokens, formatToolDuration } from "./StatsPanel";
import TextResponseBlock from "./TextResponseBlock";
import ThinkingBlock from "./ThinkingBlock";
import ToolCallBlock from "./ToolCallBlock";

// Hoisted so the default isn't re-created on every render (stable reference).
const NO_HIGHLIGHTS: TextHighlight[] = [];
import UserPromptBlock from "./UserPromptBlock";

interface Props {
  scenes: Scene[];
  visibleCount: number;
  currentIndex: number;
  effectivePrefs: EffectivePrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  annotations?: Annotation[];
  onComment?: (sceneIndex: number) => void;
  onAnnotationClick?: (annotationId: string) => void;
  state?: string;
  overlayActions?: OverlayActions;
  turnStats?: TurnStat[];
  contextLimit?: number;
  /** When set, the session is being streamed live and the trailing "the end"
   *  card is replaced with a state-aware indicator. */
  isLive?: boolean;
  /** Current Claude session state, surfaced from `~/.claude/sessions/<pid>.json`.
   *  - busy:    Claude is actively processing → red pulsing indicator.
   *  - idle:    Claude is alive, waiting for the next user prompt → green dim.
   *  - stopped: Claude exited / process is dead → muted "session ended".
   *  - unknown: non-Claude provider, no metadata file → fall back to BUSY UX.
   *  Only consulted when `isLive` is true. */
  liveSessionState?: "busy" | "idle" | "stopped" | "unknown";
  liveCursorDiagnostics?: LiveCursorDiagnostics;
  liveCursorRowsChanged?: boolean;
  liveCursorProbeAt?: number;
}

interface TurnGroup {
  type: "user" | "assistant" | "compaction" | "context-injection";
  timestamp?: string;
  scenes: { scene: Scene; index: number }[];
  turnNumber?: number;
  assistantSegmentIndex?: number;
  /** Named speaker for multi-party sessions; omitted for generic You/Assistant. */
  speaker?: string;
}

function sceneSpeaker(scene: Scene): string | undefined {
  return "speaker" in scene && typeof scene.speaker === "string" && scene.speaker.trim()
    ? scene.speaker.trim()
    : undefined;
}

interface StickyPromptSummary {
  index: number;
  turnNumber?: number;
  content: string;
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

function turnStatForNumber(
  turnStats: TurnStat[] | undefined,
  turnNumber?: number,
): TurnStat | undefined {
  if (!turnStats || turnNumber === undefined) return undefined;
  const turnIndex = turnNumber - 1;
  // Prefer the explicit index because providers may omit stats for a turn
  // that has no assistant output. Only use the positional fallback for legacy
  // replays whose stats predate `turnIndex`; otherwise a sparse array could
  // assign another turn's metrics to this card.
  const hasExplicitIndexes = turnStats.every((stat) => Number.isInteger(stat.turnIndex));
  return hasExplicitIndexes ? getTurnStat(turnStats, turnIndex) : turnStats[turnIndex];
}

function turnStatForGroup(
  turnStats: TurnStat[] | undefined,
  turnNumber: number | undefined,
  assistantSegmentIndex: number | undefined,
): TurnStat | undefined {
  if (turnStats?.some((stat) => Number.isInteger(stat.segmentIndex))) {
    if (assistantSegmentIndex === undefined) return undefined;
    return turnStats.find((stat) => stat.segmentIndex === assistantSegmentIndex);
  }
  return turnStatForNumber(turnStats, turnNumber);
}

function turnDurationFromScenes(scenes: { scene: Scene }[]): number | undefined {
  const firstTimestamp = scenes[0]?.scene.timestamp;
  const lastTimestamp = scenes[scenes.length - 1]?.scene.timestamp;
  if (!firstTimestamp || !lastTimestamp) return undefined;
  const durationMs = Date.parse(lastTimestamp) - Date.parse(firstTimestamp);
  return durationMs > 0 ? durationMs : undefined;
}

function tokenUsageTitle(usage: NonNullable<TurnStat["tokenUsage"]>): string {
  const promptTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const totalTokens = promptTokens + usage.outputTokens;
  const parts = [
    `${totalTokens.toLocaleString("en-US")} total`,
    `${promptTokens.toLocaleString("en-US")} prompt`,
    `${usage.outputTokens.toLocaleString("en-US")} output`,
  ];
  if (usage.inputTokens > 0) {
    parts.push(`${usage.inputTokens.toLocaleString("en-US")} uncached input`);
  }
  if (usage.cacheReadTokens > 0) {
    parts.push(`${usage.cacheReadTokens.toLocaleString("en-US")} cache read`);
  }
  if (usage.cacheCreationTokens > 0) {
    parts.push(
      `${usage.cacheCreationTokens.toLocaleString("en-US")} prompt cache created (not necessarily billable)`,
    );
  }
  return `Recorded cumulative token usage for this assistant turn: ${parts.join(" · ")}`;
}

function AssistantTurnMetrics({
  turnStat,
  fallbackDurationMs,
}: {
  turnStat?: TurnStat;
  fallbackDurationMs?: number;
}) {
  const durationMs = turnStat?.durationMs ?? fallbackDurationMs;
  const durationLabel = formatToolDuration(durationMs);
  const usage = turnStat?.tokenUsage;
  const hasTokenUsage = usage
    ? usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cacheCreationTokens > 0 ||
      usage.cacheReadTokens > 0
    : false;
  if (!durationLabel && !hasTokenUsage) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-terminal-dimmer">
      {durationLabel && (
        <span
          title={
            turnStat?.durationMs
              ? "Recorded or timestamp-derived active time for this assistant turn"
              : "Estimated active time from the assistant scene timestamps"
          }
        >
          · {durationLabel}
        </span>
      )}
      {usage && hasTokenUsage && (
        <span
          className="inline-flex items-center gap-1.5"
          title={tokenUsageTitle(usage)}
          aria-label="Cumulative token usage by category"
        >
          {usage.inputTokens > 0 && <span>· {formatTokens(usage.inputTokens)} in</span>}
          {usage.outputTokens > 0 && <span>· {formatTokens(usage.outputTokens)} out</span>}
          {usage.cacheReadTokens > 0 && (
            <span>· {formatTokens(usage.cacheReadTokens)} cache read</span>
          )}
        </span>
      )}
    </span>
  );
}

export default function ConversationView({
  scenes,
  visibleCount,
  currentIndex,
  effectivePrefs,
  focusIndex,
  annotatedScenes,
  annotationCounts,
  annotations,
  onComment,
  onAnnotationClick,
  onSeek,
  state,
  overlayActions,
  turnStats,
  contextLimit,
  isLive,
  liveSessionState,
  liveCursorDiagnostics,
  liveCursorRowsChanged,
  liveCursorProbeAt,
}: Props & { onSeek?: (index: number) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeStickyPrompt, setActiveStickyPrompt] = useState<StickyPromptSummary | null>(null);
  const highlightsByScene = useMemo(() => textHighlightsByScene(annotations ?? []), [annotations]);

  // Pre-compute ALL groups once — stable across playback ticks
  const allGroups = useMemo(() => {
    const result: TurnGroup[] = [];
    let current: TurnGroup | null = null;
    let turnCount = 0;
    let assistantSegmentCount = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (
        scene.type === "user-prompt" ||
        scene.type === "compaction-summary" ||
        scene.type === "context-injection"
      ) {
        if (current && current.scenes.length > 0) result.push(current);
        const type =
          scene.type === "compaction-summary"
            ? "compaction"
            : scene.type === "context-injection"
              ? "context-injection"
              : "user";
        if (type === "user") turnCount++;
        const speaker = type === "user" ? sceneSpeaker(scene) : undefined;
        result.push({
          type,
          timestamp: scene.timestamp,
          scenes: [{ scene, index: i }],
          turnNumber: type === "user" || type === "compaction" ? turnCount : undefined,
          ...(speaker ? { speaker } : {}),
        } as TurnGroup);
        current = null;
      } else {
        const speaker = sceneSpeaker(scene);
        if (!current || current.type !== "assistant" || current.speaker !== speaker) {
          if (current && current.scenes.length > 0) result.push(current);
          current = {
            type: "assistant",
            timestamp: scene.timestamp,
            scenes: [],
            turnNumber: turnCount > 0 ? turnCount : undefined,
            assistantSegmentIndex: assistantSegmentCount++,
            ...(speaker ? { speaker } : {}),
          };
        }
        current.scenes.push({ scene, index: i });
      }
    }
    if (current && current.scenes.length > 0) result.push(current);
    return result;
  }, [scenes]);

  // Show ALL turns by default — never hide content the user already has on
  // disk. Playback (the play button + currentIndex / visibleCount) now
  // controls only the camera (scroll-to-current) and the focus indicator.
  // Hiding follow-up turns made it look like content was missing — see
  // https://github.com/tuo-lei/vibe-replay/pull/215 review feedback.
  const displayGroups = useMemo(() => {
    if (effectivePrefs.promptsOnly) {
      return allGroups.filter((g) => g.type === "user" || g.type === "compaction");
    }
    return allGroups;
  }, [allGroups, effectivePrefs.promptsOnly]);

  // Find which group contains the currentIndex
  const currentGroupIdx = useMemo(() => {
    for (let i = displayGroups.length - 1; i >= 0; i--) {
      if (displayGroups[i].scenes.some((s) => s.index <= currentIndex)) {
        return i;
      }
    }
    return displayGroups.length - 1;
  }, [displayGroups, currentIndex]);

  // Compute time gaps between user-prompt groups
  const timeGaps = useMemo(() => {
    const gaps = new Map<number, number>(); // group index → gap in ms
    for (let gi = 1; gi < displayGroups.length; gi++) {
      const curr = displayGroups[gi];
      if (curr.type !== "user") continue;
      // Find the last timestamp from the previous groups (search backward)
      let prevTs: string | undefined;
      for (let j = gi - 1; j >= 0; j--) {
        const g = displayGroups[j];
        const lastScene = g.scenes[g.scenes.length - 1];
        if (lastScene?.scene.timestamp) {
          prevTs = lastScene.scene.timestamp;
          break;
        }
        if (g.timestamp) {
          prevTs = g.timestamp;
          break;
        }
      }
      if (!prevTs || !curr.timestamp) continue;
      const gap = new Date(curr.timestamp).getTime() - new Date(prevTs).getTime();
      if (gap > 120_000) gaps.set(gi, gap); // > 2 minutes
    }
    return gaps;
  }, [displayGroups]);

  const getEffectiveContent = overlayActions?.getEffectiveContent;
  const displaySections = useMemo(() => {
    const sections: {
      key: string;
      groups: { group: TurnGroup; gi: number }[];
    }[] = [];
    let current: (typeof sections)[number] | null = null;

    for (let gi = 0; gi < displayGroups.length; gi++) {
      const group = displayGroups[gi];
      const firstIndex = group.scenes[0]?.index ?? gi;

      if (group.type === "user") {
        current = {
          key: `turn-${firstIndex}`,
          groups: [{ group, gi }],
        };
        sections.push(current);
        continue;
      }

      if (current) {
        current.groups.push({ group, gi });
      } else {
        sections.push({
          key: `prelude-${firstIndex}`,
          groups: [{ group, gi }],
        });
      }
    }

    return sections;
  }, [displayGroups]);

  const userPromptSummaries = useMemo(
    () =>
      displayGroups
        .filter((group) => group.type === "user")
        .flatMap<StickyPromptSummary>((group) => {
          const item = group.scenes[0];
          if (!item || item.scene.type !== "user-prompt") return [];
          return [
            {
              index: item.index,
              turnNumber: group.turnNumber,
              content: getEffectiveContent?.(item.index) ?? item.scene.content,
            },
          ];
        }),
    [displayGroups, getEffectiveContent],
  );

  useEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest("[data-replay-scroll-container]");
    if (!(root instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;

    let frame = 0;
    let lastIndex: number | null = null;
    const update = () => {
      frame = 0;
      const scrollerTop = scroller.getBoundingClientRect().top;
      let active: StickyPromptSummary | null = null;

      for (const prompt of userPromptSummaries) {
        const el = root.querySelector(`[data-sticky-prompt-index="${prompt.index}"]`);
        if (!(el instanceof HTMLElement)) continue;
        if (el.getBoundingClientRect().bottom <= scrollerTop + 2) {
          active = prompt;
        } else {
          break;
        }
      }

      const nextIndex = active?.index ?? null;
      if (nextIndex !== lastIndex) {
        lastIndex = nextIndex;
        setActiveStickyPrompt(active);
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };

    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [userPromptSummaries]);

  return (
    <div ref={rootRef} className="max-w-4xl mx-auto pb-6">
      <ActiveStickyPrompt prompt={activeStickyPrompt} />
      <div className="space-y-5">
        {displaySections.map((section) => (
          <div key={section.key} className="space-y-5">
            {section.groups.map(({ group, gi }) => {
              const card = (
                <>
                  {timeGaps.has(gi) && <TimeGapIndicator gapMs={timeGaps.get(gi)!} />}
                  <GroupCard
                    group={group}
                    currentIndex={currentIndex}
                    effectivePrefs={effectivePrefs}
                    focusIndex={focusIndex}
                    annotatedScenes={annotatedScenes}
                    annotationCounts={annotationCounts}
                    highlightsByScene={highlightsByScene}
                    onComment={onComment}
                    onAnnotationClick={onAnnotationClick}
                    overlayActions={overlayActions}
                    turnStats={turnStats}
                    contextLimit={contextLimit}
                  />
                </>
              );
              const firstIndex = group.scenes[0]?.index;
              return (
                <LazyGroup
                  key={gi}
                  forceRender={gi >= currentGroupIdx - 15 && gi <= currentGroupIdx + 5}
                  stickyPromptIndex={group.type === "user" ? firstIndex : undefined}
                >
                  {card}
                </LazyGroup>
              );
            })}
          </div>
        ))}
        {state === "paused" && visibleCount < scenes.length && (
          <div className="pt-4 pb-12 flex items-center justify-center animate-in fade-in slide-in-from-bottom-2 duration-700 ease-out select-none">
            <div className="group/pause relative flex items-center gap-8 px-4 py-2 bg-transparent backdrop-blur-sm">
              {/* Ambient Glow */}
              <div className="absolute inset-0 bg-terminal-tool/5 opacity-0 group-hover/pause:opacity-100 transition-opacity duration-700 blur-2xl -z-10" />

              {/* Left: Status Label */}
              <div className="flex items-center gap-2.5 pr-8 border-r border-terminal-border/20">
                <div className="relative flex h-2 w-2">
                  <div className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminal-tool opacity-40"></div>
                  <div className="relative inline-flex rounded-full h-2 w-2 bg-terminal-tool/80 shadow-[0_0_8px_rgba(251,146,60,0.5)]"></div>
                </div>
                <span className="ui-section-title text-terminal-tool drop-shadow-sm">Paused</span>
              </div>

              {/* Right: Interaction Hints */}
              <div className="flex items-center gap-8">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-terminal-surface-hover/80 border border-terminal-border-subtle/50 text-terminal-text shadow-sm">
                    <span className="text-[11px] font-mono font-bold">&darr;</span>
                  </div>
                  <span className="ui-caption text-terminal-dim opacity-80">Explore</span>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-terminal-surface-hover/80 border border-terminal-border-subtle/50 text-terminal-text shadow-sm">
                    <span className="text-[9px] font-mono font-black tracking-tight">SPACE</span>
                  </div>
                  <span className="ui-caption text-terminal-dim opacity-80">Resume</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {visibleCount >= scenes.length && !isLive && (
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
                <div className="w-1 h-1 rounded-full bg-terminal-user" />
                <div className="w-1 h-1 rounded-full bg-terminal-response" />
                <div className="w-1 h-1 rounded-full bg-terminal-tool" />
              </div>
            </div>
          </div>
        )}

        {visibleCount >= scenes.length && isLive && (
          <LiveStateCard
            cursorDiagnostics={liveCursorDiagnostics}
            cursorRowsChanged={liveCursorRowsChanged}
            cursorProbeAt={liveCursorProbeAt}
            sessionState={liveSessionState}
          />
        )}
      </div>
    </div>
  );
}

function ActiveStickyPrompt({ prompt }: { prompt: StickyPromptSummary | null }) {
  if (!prompt) return null;

  return (
    <div className="sticky top-0 z-30 h-0">
      <div
        className="turn-sticky-summary pointer-events-none -translate-y-3 mx-auto flex max-w-4xl items-center gap-3 rounded-full border border-terminal-user/25 px-4 py-1.5 font-mono text-xs leading-5 text-terminal-user shadow-layer-md"
        title={prompt.content}
      >
        <span className="min-w-0 flex-1 truncate">{prompt.content}</span>
        {prompt.turnNumber !== undefined && (
          <span className="shrink-0 text-[10px] font-bold text-terminal-dimmer">
            #{String(prompt.turnNumber).padStart(2, "0")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Trailing card for live mode. Branches on the Claude session state so the
 * user gets honest feedback about whether anything is going to happen:
 *
 * - `busy`              — red pulsing dot, "BUSY" + the waiting message.
 *                         Claude is mid-turn (streaming, running a tool).
 * - `idle`              — green dot (no animation), "IDLE" + "Claude is
 *                         waiting for your next prompt". File watcher will
 *                         not show progress until you submit something.
 * - `stopped`           — muted gray, "ENDED" + "the Claude process exited".
 *                         Tells the user that further updates won't arrive
 *                         and they should just read this as a static replay.
 * - `unknown` / undef.  — fall back to the busy UI for non-Claude providers
 *                         (Cursor / Codex etc.) where we can't tell.
 */
function LiveStateCard({
  cursorDiagnostics,
  cursorRowsChanged,
  cursorProbeAt,
  sessionState,
}: {
  cursorDiagnostics?: LiveCursorDiagnostics;
  cursorRowsChanged?: boolean;
  cursorProbeAt?: number;
  sessionState?: "busy" | "idle" | "stopped" | "unknown";
}) {
  const effective = sessionState ?? "busy";

  if (effective === "unknown" && cursorDiagnostics) {
    const latestAt =
      cursorDiagnostics.latestBubbleUpdatedAt ||
      cursorDiagnostics.latestBubbleCreatedAt ||
      cursorDiagnostics.composerLastUpdatedAt;
    const latestAge = formatCompactAge(latestAt);
    const probeAge = cursorProbeAt ? formatCompactAge(new Date(cursorProbeAt).toISOString()) : "";
    const latestLabel = cursorDiagnostics.latestToolName
      ? `${displayToolName(cursorDiagnostics.latestToolName)} ${
          cursorDiagnostics.latestToolHasResult ? "result persisted" : "waiting for result"
        }`
      : cursorDiagnostics.latestTextPreview
        ? "assistant text persisted"
        : "session rows persisted";
    const rowState = cursorRowsChanged === false ? "db event, rows unchanged" : "rows updated";
    return (
      <div className="pt-10 pb-24 flex flex-col items-center justify-center select-none">
        <div className="h-px w-8 bg-terminal-border-subtle mb-5" />
        <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-terminal-response-subtle/40 border border-terminal-response/20">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-response" />
          <span className="text-[10px] font-mono font-bold text-terminal-response uppercase tracking-[0.25em]">
            Cursor Live
          </span>
        </div>
        <div className="text-[9px] font-mono text-terminal-dimmer mt-3 tracking-wide">
          {latestLabel}
          {latestAge ? ` · durable ${latestAge}` : ""}
        </div>
        <div className="text-[9px] font-mono text-terminal-dimmer mt-1 tracking-wide">
          {cursorDiagnostics.bubbleCount} bubbles
          {cursorDiagnostics.toolCallCount > 0
            ? ` · ${cursorDiagnostics.toolResultCount}/${cursorDiagnostics.toolCallCount} tool results`
            : ""}
          {" · "}
          {rowState}
          {probeAge ? ` · probed ${probeAge}` : ""}
        </div>
      </div>
    );
  }

  if (effective === "stopped") {
    return (
      <div className="pt-10 pb-24 flex flex-col items-center justify-center select-none">
        <div className="h-px w-8 bg-terminal-border-subtle mb-5" />
        <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-terminal-surface/40 border border-terminal-border-subtle">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-dimmer" />
          <span className="text-[10px] font-mono font-bold text-terminal-dim uppercase tracking-[0.25em]">
            Ended
          </span>
        </div>
        <div className="text-[9px] font-mono text-terminal-dimmer mt-3 tracking-wide">
          the claude process exited — no further updates will arrive
        </div>
      </div>
    );
  }

  if (effective === "idle") {
    return (
      <div className="pt-10 pb-24 flex flex-col items-center justify-center select-none">
        <div className="h-px w-8 bg-terminal-border-subtle mb-5" />
        <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-terminal-user-subtle/40 border border-terminal-user/20">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-user" />
          <span className="text-[10px] font-mono font-bold text-terminal-user uppercase tracking-[0.25em]">
            Idle
          </span>
        </div>
        <div className="text-[9px] font-mono text-terminal-dimmer mt-3 tracking-wide">
          claude is waiting for your next prompt
        </div>
      </div>
    );
  }

  // busy + unknown: amber pulsing UI; red is reserved for failures.
  return (
    <div className="pt-10 pb-24 flex flex-col items-center justify-center select-none">
      <div className="h-px w-8 bg-terminal-border-subtle mb-5" />
      <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-terminal-tool-subtle/50 border border-terminal-tool/20">
        <span className="relative flex w-2 h-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-terminal-tool opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-tool" />
        </span>
        <span className="text-[10px] font-mono font-bold text-terminal-tool uppercase tracking-[0.25em]">
          Busy
        </span>
      </div>
      <div className="text-[9px] font-mono text-terminal-dimmer mt-3 tracking-wide">
        waiting for the next turn to land on disk
      </div>
    </div>
  );
}

function formatCompactAge(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function TimeGapIndicator({ gapMs }: { gapMs: number }) {
  const label =
    gapMs >= 3600_000
      ? `${Math.floor(gapMs / 3600_000)}h ${Math.floor((gapMs % 3600_000) / 60_000)}m later`
      : `${Math.floor(gapMs / 60_000)}m later`;
  return (
    <div className="flex items-center gap-3 py-1 px-4">
      <div className="flex-1 h-px bg-terminal-border-subtle" />
      <span className="text-[10px] font-mono text-terminal-dimmer whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-terminal-border-subtle" />
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
  stickyPromptIndex,
}: {
  children: React.ReactNode;
  forceRender: boolean;
  stickyPromptIndex?: number;
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
      data-sticky-prompt-index={stickyPromptIndex}
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
  effectivePrefs,
  focusIndex,
  annotatedScenes: _annotatedScenes,
  annotationCounts,
  highlightsByScene,
  onComment,
  onAnnotationClick,
  overlayActions,
  turnStats,
  contextLimit,
}: {
  group: TurnGroup;
  currentIndex: number;
  effectivePrefs: EffectivePrefs;
  focusIndex?: number;
  annotatedScenes?: Set<number>;
  annotationCounts?: Map<number, number>;
  highlightsByScene?: Map<number, TextHighlight[]>;
  onComment?: (sceneIndex: number) => void;
  onAnnotationClick?: (annotationId: string) => void;
  overlayActions?: OverlayActions;
  turnStats?: TurnStat[];
  contextLimit?: number;
}) {
  const [hovered, setHovered] = useState(false);

  // Use the configured/provider-supplied limit when available. The display
  // ceiling only controls the bar's visual scale; it must not turn an
  // observed peak into a fabricated 1M context limit.
  const contextCeiling = useMemo(() => {
    return getContextScale(turnStats || [], contextLimit).displayMax;
  }, [contextLimit, turnStats]);

  const turnStatsByIndex = useMemo(() => {
    const result = new Map<number, TurnStat>();
    for (const stat of turnStats || []) {
      if (!result.has(stat.turnIndex)) result.set(stat.turnIndex, stat);
    }
    return result;
  }, [turnStats]);

  // Render every scene in the group — no longer gated by visibleCount.
  // Playback advance still updates currentIndex (used for the focus
  // indicator + scroll-follow), but never hides content.
  const groupScenes = group.scenes;
  const turnStat = turnStatForGroup(turnStats, group.turnNumber, group.assistantSegmentIndex);
  const fallbackTurnDurationMs = useMemo(() => turnDurationFromScenes(groupScenes), [groupScenes]);

  const groupHasCurrent = groupScenes.some(({ index }) => index === currentIndex);
  const groupHasFocusedTarget =
    typeof focusIndex === "number" && groupScenes.some(({ index }) => index === focusIndex);
  const firstIndex = groupScenes[0]?.index;

  if (groupScenes.length === 0) return null;

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
            ? "scene-nav-focused bg-terminal-user-emphasis border-terminal-user shadow-layer-lg"
            : groupHasCurrent
              ? "bg-terminal-user-subtle border-terminal-user/30 shadow-layer-sm"
              : "bg-terminal-surface border-terminal-border-subtle shadow-sm"
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {userCommentButton}
        <div className="flex items-center gap-2 mb-2.5">
          <span className="ui-section-title text-terminal-user">
            {userSpeakerLabel(group.speaker)}
          </span>
          {group.timestamp && (
            <span className="text-[10px] font-mono text-terminal-dimmer">
              {formatTime(group.timestamp)}
            </span>
          )}
          <div className="flex-1" />
          {groupHasFocusedTarget ? (
            <span className="ui-pill-compact bg-terminal-user text-terminal-bg">Jump Target</span>
          ) : (
            groupHasCurrent && (
              <span className="ui-pill-compact bg-terminal-user-subtle text-terminal-user border border-terminal-user/20">
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
        {/* Context token indicator */}
        {group.turnNumber !== undefined &&
          turnStats &&
          (() => {
            const ts = turnStatsByIndex.get(group.turnNumber! - 1);
            if (!ts?.contextTokens) return null;
            const semanticLimit = contextLimit || contextCeiling;
            const pct = Math.min((ts.contextTokens / semanticLimit) * 100, 100);
            const ratio = contextLimit ? ts.contextTokens / semanticLimit : 0;
            const barColor = !contextLimit
              ? "bg-terminal-context"
              : ratio >= 0.85
                ? "bg-terminal-tool"
                : ratio >= 0.7
                  ? "bg-terminal-tool"
                  : ratio >= 0.5
                    ? "bg-terminal-tool"
                    : "bg-terminal-user";
            const textColor = !contextLimit
              ? "text-terminal-context"
              : ratio >= 0.85
                ? "text-terminal-tool"
                : ratio >= 0.7
                  ? "text-terminal-tool"
                  : "text-terminal-dim";
            return (
              <div className="mb-2 flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-terminal-surface overflow-hidden">
                  <div
                    className={`h-full rounded-full ${barColor} transition-all duration-300`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={`text-[9px] font-mono tabular-nums ${textColor}`}>
                  {fmtNum(ts.contextTokens)}
                  {contextLimit ? ` / ${fmtNum(contextLimit)}` : ""}
                  <span className="text-terminal-dimmer ml-1">
                    {contextLimit ? "reported prompt tokens" : "reported prompt footprint"}
                  </span>
                </span>
              </div>
            );
          })()}
        <div className="text-left">
          {groupScenes.map(({ scene, index }) => {
            const sceneOverlays = overlayActions?.getOverlays(index) ?? [];
            const effectiveContent = overlayActions?.getEffectiveContent(index);
            const isShowingOriginal = overlayActions?.showOriginal.has(index);
            return (
              <div key={index} className="scene-enter">
                <SceneBlock
                  scene={scene}
                  isActive={index === currentIndex}
                  collapseTools={effectivePrefs.collapseAllTools}
                  effectiveContent={effectiveContent ?? undefined}
                  highlights={highlightsByScene?.get(index) ?? []}
                  onHighlightClick={onAnnotationClick}
                />
                {sceneOverlays.length > 0 && (
                  <div className="flex items-center gap-2 mt-1.5">
                    {sceneOverlays.map((o) => (
                      <span
                        key={o.id}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple"
                      >
                        {o.source.type === "translate"
                          ? "Translated"
                          : o.source.type === "tone"
                            ? "Softened"
                            : "Modified"}
                      </span>
                    ))}
                    <button
                      onClick={() => overlayActions?.toggleOriginal(index)}
                      className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                    >
                      {isShowingOriginal ? "Show modified" : "Show original"}
                    </button>
                    <button
                      onClick={() => overlayActions?.revertSceneOverlays(index)}
                      className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors"
                    >
                      Revert
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (group.type === "compaction") {
    const scene = groupScenes[0]?.scene;
    if (!scene || scene.type !== "compaction-summary") return null;

    // Find observed context-drop impact from turnStats near this recorded
    // compaction's preceding user turn. A missing drop is not evidence that
    // the recorded compaction did not happen.
    const compactionTokens = (() => {
      if (!turnStats || turnStats.length < 2 || group.turnNumber === undefined) return undefined;
      const center = group.turnNumber - 1;
      const drop = findContextDrops(turnStats).find(
        (candidate) =>
          Math.abs(candidate.beforeTurnIndex - center) <= 2 ||
          Math.abs(candidate.afterTurnIndex - center) <= 2,
      );
      return drop
        ? { before: drop.before, after: drop.after, freed: drop.before - drop.after }
        : undefined;
    })();

    return (
      <div
        id={`scene-${firstIndex}`}
        data-scene-index={firstIndex}
        className={`group relative rounded-xl px-5 py-3.5 transition-all duration-200 ease-material ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-context-subtle/70 border border-terminal-context/30 shadow-layer-sm"
            : groupHasCurrent
              ? "bg-terminal-context-subtle/50 border border-terminal-context/20 shadow-layer-sm"
              : "bg-terminal-surface/50 border border-terminal-context/10"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="ui-section-title text-terminal-context">Context Compaction</span>
          {group.timestamp && (
            <span className="text-xs font-mono text-terminal-dimmer">
              {formatTime(group.timestamp)}
            </span>
          )}
          {compactionTokens && (
            <span className="text-[10px] font-mono text-terminal-context">
              {fmtNum(compactionTokens.before)} → {fmtNum(compactionTokens.after)}
              <span className="text-terminal-context/70 ml-1">
                (observed drop, -{fmtNum(compactionTokens.freed)} tokens)
              </span>
            </span>
          )}
        </div>
        <CompactionSummaryBlock
          content={scene.content}
          isActive={firstIndex === currentIndex}
          highlights={highlightsByScene?.get(firstIndex) ?? []}
          onHighlightClick={onAnnotationClick}
        />
      </div>
    );
  }

  if (group.type === "context-injection") {
    const scene = groupScenes[0]?.scene;
    if (!scene || scene.type !== "context-injection") return null;
    const it = scene.injectionType || "system";
    const label = it.startsWith("skill:")
      ? `Skill: ${it.slice(6)}`
      : it.startsWith("command:")
        ? `Command: ${it.slice(8)}`
        : it === "image"
          ? "Image Injection"
          : it === "local-command"
            ? "Local Command"
            : "System Context";
    return (
      <div
        id={`scene-${firstIndex}`}
        data-scene-index={firstIndex}
        className={`group relative rounded-xl px-5 py-3.5 transition-all duration-200 ease-material ${
          groupHasFocusedTarget
            ? "scene-nav-focused bg-terminal-context-subtle/70 border border-terminal-context/30 shadow-layer-sm"
            : groupHasCurrent
              ? "bg-terminal-context-subtle/50 border border-terminal-context/20 shadow-layer-sm"
              : "bg-terminal-surface/50 border border-terminal-context/10"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="ui-section-title text-terminal-context">{label}</span>
          {group.timestamp && (
            <span className="text-xs font-mono text-terminal-dimmer">
              {formatTime(group.timestamp)}
            </span>
          )}
        </div>
        <CompactionSummaryBlock
          content={scene.content}
          isActive={firstIndex === currentIndex}
          highlights={highlightsByScene?.get(firstIndex) ?? []}
          onHighlightClick={onAnnotationClick}
        />
      </div>
    );
  }

  // Assistant group — filter by effectivePrefs
  const filteredScenes = effectivePrefs.hideThinking
    ? groupScenes.filter((s) => s.scene.type !== "thinking")
    : groupScenes;

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
        speaker={group.speaker}
        annotationCounts={annotationCounts}
        highlightsByScene={highlightsByScene}
        onComment={onComment}
        onAnnotationClick={onAnnotationClick}
        overlayActions={overlayActions}
        turnStat={turnStat}
      />
    );
  }

  return (
    <div
      id={`scene-${firstIndex}`}
      data-scene-index={firstIndex}
      className={`relative rounded-xl px-5 py-4 transition-all duration-200 ease-material ${
        groupHasFocusedTarget
          ? "scene-nav-focused bg-terminal-response-subtle shadow-layer-lg"
          : groupHasCurrent
            ? "bg-terminal-response-subtle shadow-layer-sm"
            : "bg-terminal-surface shadow-layer-sm"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="ui-section-title text-terminal-response">
          {assistantSpeakerLabel(group.speaker)}
        </span>
        {group.timestamp && (
          <span className="text-[10px] font-mono text-terminal-dimmer">
            {formatTime(group.timestamp)}
          </span>
        )}
        {group.type === "assistant" && (
          <AssistantTurnMetrics turnStat={turnStat} fallbackDurationMs={fallbackTurnDurationMs} />
        )}
        <div className="flex-1" />
        {groupHasFocusedTarget ? (
          <span className="ui-pill-compact bg-terminal-response-emphasis text-terminal-response">
            Jump Target
          </span>
        ) : (
          groupHasCurrent && (
            <span className="ui-pill-compact bg-terminal-response-subtle text-terminal-response">
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
          highlightsByScene={highlightsByScene}
          onAnnotationClick={onAnnotationClick}
          overlayActions={overlayActions}
        />
      </div>
    </div>
  );
});

// MCP tool name formatting is in ../utils/toolName.ts (shared with ToolCallBlock)

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
  speaker,
  annotationCounts,
  highlightsByScene,
  onComment,
  onAnnotationClick,
  overlayActions,
  turnStat,
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
  speaker?: string;
  annotationCounts?: Map<number, number>;
  highlightsByScene?: Map<number, TextHighlight[]>;
  onComment?: (sceneIndex: number) => void;
  onAnnotationClick?: (annotationId: string) => void;
  overlayActions?: OverlayActions;
  turnStat?: TurnStat;
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
    let subAgentCalls = 0;
    const subAgentTypes: string[] = [];
    for (const { scene } of allScenes) {
      if (scene.type === "tool-call") {
        totalTools++;
        if (scene.toolName === "Agent" && scene.subAgent) {
          subAgentCalls++;
          if (!subAgentTypes.includes(scene.subAgent.agentType)) {
            subAgentTypes.push(scene.subAgent.agentType);
          }
        }
        const displayName = displayToolName(scene.toolName);
        toolBreakdown[displayName] = (toolBreakdown[displayName] || 0) + 1;
        if (scene.toolName === "Bash" && scene.input?.command) {
          const cmd = scene.input.command.trim().split(/[\s|;&]/)[0];
          if (cmd) bashCommands.add(cmd);
        }
      } else if (scene.type === "text-response") responses++;
      else if (scene.type === "thinking") thinking++;
    }
    const turnDurationMs = turnDurationFromScenes(allScenes);

    return {
      totalTools,
      toolBreakdown,
      responses,
      thinking,
      bashCommands: [...bashCommands],
      subAgentCalls,
      subAgentTypes,
      turnDurationMs,
    };
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
    const order = [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Delete",
      "Bash",
      "Glob",
      "Grep",
      "SemanticSearch",
      "Browser",
      "Agent",
    ];
    const priority = (name: string) => {
      const index = order.indexOf(name);
      return index >= 0 ? index : 100;
    };
    const entries = Object.entries(stats.toolBreakdown);
    entries.sort((a, b) => {
      const byPriority = priority(a[0]) - priority(b[0]);
      if (byPriority !== 0) return byPriority;
      const byCount = b[1] - a[1];
      return byCount !== 0 ? byCount : a[0].localeCompare(b[0]);
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
          ? "scene-nav-focused bg-terminal-response-subtle shadow-layer-lg"
          : groupHasCurrent
            ? "bg-terminal-response-subtle shadow-layer-sm"
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
        <span className="ui-section-title text-terminal-response">
          {assistantSpeakerLabel(speaker)}
        </span>
        {timestamp && (
          <span className="text-[10px] font-mono text-terminal-dimmer">
            {formatTime(timestamp)}
          </span>
        )}
        <AssistantTurnMetrics turnStat={turnStat} fallbackDurationMs={stats.turnDurationMs} />
        <div className="flex-1" />
        {groupHasFocusedTarget ? (
          <span className="ui-pill-compact bg-terminal-response-emphasis text-terminal-response">
            Jump Target
          </span>
        ) : (
          groupHasCurrent && (
            <span className="ui-pill-compact bg-terminal-response-subtle text-terminal-response">
              Focused
            </span>
          )
        )}
      </div>

      {/* Compact stats bar — stable, computed from ALL scenes */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[11px] font-mono">
        {stats.responses > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-response-subtle text-terminal-response">
            {stats.responses} response{stats.responses > 1 ? "s" : ""}
          </span>
        )}
        {stats.totalTools > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-tool-subtle text-terminal-tool">
            {stats.totalTools} tool{stats.totalTools > 1 ? "s" : ""}
          </span>
        )}
        {stats.subAgentCalls > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-thinking-subtle text-terminal-thinking">
            {stats.subAgentCalls} agent{stats.subAgentCalls > 1 ? "s" : ""}
            {stats.subAgentTypes.length > 0 && (
              <span className="opacity-70 text-[10px]">({stats.subAgentTypes.join(", ")})</span>
            )}
          </span>
        )}
        {stats.thinking > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-thinking-subtle text-terminal-thinking">
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
                <span className="text-terminal-tool">{name}</span>
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
            content={
              overlayActions?.getEffectiveContent(lastTextResponse.index) ??
              (lastTextResponse.scene as Extract<Scene, { type: "text-response" }>).content
            }
            isActive={lastTextResponse.index === currentIndex}
          />
        </div>
      )}

      {/* Expanded: show visible scenes so far with per-scene comment buttons */}
      {expanded && (
        <div className="space-y-2 mb-2">
          {filteredScenes.map(({ scene, index }) => {
            const count = annotationCounts?.get(index) || 0;
            const ec =
              scene.type === "text-response"
                ? (overlayActions?.getEffectiveContent(index) ?? undefined)
                : undefined;
            return (
              <div
                key={index}
                data-scene-index={index}
                className={`group/scene relative scene-enter ${onComment ? "pr-7" : ""}`}
              >
                <SceneBlock
                  scene={scene}
                  isActive={index === currentIndex}
                  collapseTools={false}
                  effectiveContent={ec}
                  highlights={highlightsByScene?.get(index) ?? []}
                  onHighlightClick={onAnnotationClick}
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
  highlightsByScene,
  onAnnotationClick,
  overlayActions,
}: {
  scenes: { scene: Scene; index: number }[];
  currentIndex: number;
  collapseTools: boolean;
  annotationCounts?: Map<number, number>;
  onComment?: (sceneIndex: number) => void;
  highlightsByScene?: Map<number, TextHighlight[]>;
  onAnnotationClick?: (annotationId: string) => void;
  overlayActions?: OverlayActions;
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
          const effectiveContent =
            scene.type === "text-response" ? overlayActions?.getEffectiveContent(index) : undefined;
          const sceneOverlays =
            scene.type === "text-response" ? (overlayActions?.getOverlays(index) ?? []) : [];
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
                effectiveContent={effectiveContent ?? undefined}
                highlights={highlightsByScene?.get(index) ?? []}
                onHighlightClick={onAnnotationClick}
              />
              {sceneOverlays.length > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  {sceneOverlays.map((o) => (
                    <span
                      key={o.id}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple"
                    >
                      {o.source.type === "translate"
                        ? "Translated"
                        : o.source.type === "tone"
                          ? "Softened"
                          : "Modified"}
                    </span>
                  ))}
                  <button
                    onClick={() => overlayActions?.toggleOriginal(index)}
                    className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                  >
                    {overlayActions?.showOriginal.has(index) ? "Show modified" : "Show original"}
                  </button>
                  <button
                    onClick={() => overlayActions?.revertSceneOverlays(index)}
                    className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors"
                  >
                    Revert
                  </button>
                </div>
              )}
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

  // Aggregate token/duration across the batch — one glance at "what did this
  // burst of tool calls cost the context window?"
  let batchTokens = 0;
  let batchMs = 0;
  for (const { scene } of batch) {
    if (scene.type === "tool-call") {
      if (scene.resultTokens) batchTokens += scene.resultTokens;
      if (scene.durationMs) batchMs += scene.durationMs;
    }
  }
  const batchTokenLabel = formatTokens(batchTokens);
  const batchDurationLabel = formatToolDuration(batchMs);
  const batchHasError = batch.some(
    ({ scene }) => scene.type === "tool-call" && scene.isError === true,
  );

  return (
    <div
      data-scene-index={batch[0].index}
      className={`group/batch relative ${onComment ? "pr-7" : ""}`}
    >
      {/* Collapsed summary */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3.5 py-2.5 text-xs font-mono text-terminal-dim rounded-xl transition-all duration-200 ease-material cursor-pointer text-left shadow-layer-sm ${batchHasError ? "bg-terminal-error-subtle ring-1 ring-terminal-error/30" : "bg-terminal-surface hover:bg-terminal-surface-hover"}`}
      >
        <span className={`transition-transform text-xs ${expanded ? "rotate-90" : ""}`}>
          {"\u25B6"}
        </span>
        <span
          className={
            batchHasError ? "text-terminal-error font-semibold" : "text-terminal-tool font-semibold"
          }
        >
          {toolName}
        </span>
        <span className="text-terminal-dimmer">
          {batch.length} call{batch.length > 1 ? "s" : ""}
        </span>
        {!expanded && (
          <span className="truncate text-terminal-dimmer ml-1 flex-1">
            {summaries.filter(Boolean).slice(0, 3).join(", ")}
            {summaries.filter(Boolean).length > 3 && "..."}
          </span>
        )}
        {!expanded && batchTokenLabel && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={`~${batchTokenLabel} tokens added to context across ${batch.length} call${batch.length > 1 ? "s" : ""}`}
          >
            ~{batchTokenLabel} tok
          </span>
        )}
        {!expanded && batchDurationLabel && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={`Combined tool execution: ${batchDurationLabel}`}
          >
            {batchDurationLabel}
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
  effectiveContent,
  highlights = NO_HIGHLIGHTS,
  onHighlightClick,
}: {
  scene: Scene;
  isActive: boolean;
  collapseTools: boolean;
  effectiveContent?: string;
  highlights?: TextHighlight[];
  onHighlightClick?: (annotationId: string) => void;
}) {
  switch (scene.type) {
    case "user-prompt":
      return (
        <UserPromptBlock
          content={effectiveContent ?? scene.content}
          images={scene.images}
          isActive={isActive}
          highlights={highlights}
          onHighlightClick={onHighlightClick}
        />
      );
    case "compaction-summary":
      return (
        <CompactionSummaryBlock
          content={scene.content}
          isActive={isActive}
          highlights={highlights}
          onHighlightClick={onHighlightClick}
        />
      );
    case "context-injection":
      return (
        <CompactionSummaryBlock
          content={scene.content}
          isActive={isActive}
          highlights={highlights}
          onHighlightClick={onHighlightClick}
        />
      );
    case "thinking":
      return (
        <ThinkingBlock
          content={scene.content}
          isActive={isActive}
          tokens={scene.tokens}
          highlights={highlights}
          onHighlightClick={onHighlightClick}
        />
      );
    case "text-response":
      return (
        <>
          <TextResponseBlock
            content={effectiveContent ?? scene.content}
            isActive={isActive}
            highlights={highlights}
            onHighlightClick={onHighlightClick}
          />
          {scene.isTruncated && (
            <div className="mt-1 text-[10px] font-mono text-terminal-tool/70 italic">
              Response truncated (max_tokens reached)
            </div>
          )}
        </>
      );
    case "tool-call":
      return <ToolCallBlock scene={scene} isActive={isActive} forceCollapse={collapseTools} />;
  }
});
