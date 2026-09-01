import { useId, useMemo } from "react";
import {
  buildActivityTiming,
  type ActivityInterval,
  type ToolCategory,
} from "../engine/activity-timing";
import type { Scene } from "../types";

type TimedActivityKind = ActivityInterval["kind"];

const ACTIVITY_META: Record<
  TimedActivityKind,
  { label: string; color: string; textColor: string }
> = {
  "llm-wait": {
    label: "LLM wait",
    color: "bg-terminal-thinking",
    textColor: "text-terminal-thinking",
  },
  response: {
    label: "Response / generation",
    color: "bg-terminal-response",
    textColor: "text-terminal-response",
  },
  tool: { label: "Tool execution", color: "bg-terminal-tool", textColor: "text-terminal-tool" },
  context: {
    label: "Compaction / context",
    color: "bg-terminal-context",
    textColor: "text-terminal-context",
  },
  unknown: {
    label: "Unattributed gap",
    color: "bg-terminal-surface-2",
    textColor: "text-terminal-dim",
  },
};

const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  test: "test",
  lint: "lint",
  build: "build",
  check: "check",
  file: "file",
  other: "other",
};

function formatActivityDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatActivityPercent(value: number, total: number): string {
  if (total <= 0 || value <= 0) return "0%";
  const percent = (value / total) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function intervalTitle(interval: ActivityInterval): string {
  const meta = ACTIVITY_META[interval.kind];
  const source =
    interval.source === "tool-duration"
      ? "provider-recorded tool duration"
      : interval.note === "compaction-duration-estimate"
        ? "timestamp gap to compaction record; duration estimated, start not persisted"
        : interval.note === "context-boundary"
          ? "timestamp gap before context boundary; compaction duration unknown"
          : interval.note === "unmeasured-tool"
            ? "timestamp gap includes a tool with no recorded duration"
            : "timestamp gap; activity role inferred";
  const tool = interval.toolName
    ? ` · ${interval.toolName}${interval.toolCategory ? ` (${TOOL_CATEGORY_LABELS[interval.toolCategory]})` : ""}`
    : "";
  return `${meta.label} · ${formatActivityDuration(interval.durationMs)}${tool} · ${source}`;
}

function categorySummary(
  category: ToolCategory,
  durationMs: number,
  count: number,
): string | undefined {
  if (count === 0) return undefined;
  return `${TOOL_CATEGORY_LABELS[category]} ${formatActivityDuration(durationMs)}`;
}

export default function TurnActivityTimeline({ scenes }: { scenes: readonly Scene[] }) {
  const descriptionId = useId();
  const timing = useMemo(() => buildActivityTiming(scenes), [scenes]);
  const visibleKinds = useMemo(() => {
    const kinds = (Object.keys(ACTIVITY_META) as TimedActivityKind[]).filter((kind) =>
      timing.intervals.some((interval) => interval.kind === kind),
    );
    if (timing.contextBoundaries.length > 0 && !kinds.includes("context")) {
      kinds.push("context");
    }
    return kinds;
  }, [timing.contextBoundaries.length, timing.intervals]);
  const toolCategorySummaries = (Object.keys(TOOL_CATEGORY_LABELS) as ToolCategory[])
    .map((category) =>
      categorySummary(
        category,
        timing.toolCategories[category].durationMs,
        timing.toolCategories[category].count,
      ),
    )
    .filter((summary): summary is string => summary !== undefined);

  if (timing.totalMs <= 0 && timing.contextBoundaries.length === 0) return null;

  const totals = visibleKinds.map((kind) => ({
    kind,
    durationMs: timing.intervals
      .filter((interval) => interval.kind === kind)
      .reduce((sum, interval) => sum + interval.durationMs, 0),
  }));
  const accessibleSummary = [
    ...totals.map(
      ({ kind, durationMs }) =>
        `${ACTIVITY_META[kind].label}: ${formatActivityDuration(durationMs)}`,
    ),
    `Compaction/context boundaries: ${timing.contextBoundaries.length}`,
    `${timing.thinkingCount} thinking blocks folded into model activity`,
  ].join(". ");

  return (
    <div className="rounded-xl bg-terminal-surface p-4 shadow-layer-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="ui-section-title-strong">Activity timeline</div>
          <p id={descriptionId} className="mt-1 text-[10px] font-mono text-terminal-dimmer">
            Agent time only: user idle is excluded; prompt-to-assistant gaps are LLM wait. Other gap
            roles are inferred; compaction time is estimated from its preceding gap.
          </p>
        </div>
        {timing.totalMs > 0 && (
          <span className="shrink-0 text-[10px] font-mono text-terminal-dim tabular-nums">
            {formatActivityDuration(timing.totalMs)} represented
          </span>
        )}
      </div>

      {timing.totalMs > 0 ? (
        <div
          className="relative mt-4 flex h-5 overflow-hidden rounded-full bg-terminal-surface-2"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- composite timeline visualization, not an image asset
          role="img"
          aria-describedby={descriptionId}
          aria-label="Activity timeline"
        >
          {timing.intervals.map((interval, index) => (
            <div
              key={`${interval.sceneIndex}-${interval.kind}-${index}`}
              aria-hidden="true"
              className={`${ACTIVITY_META[interval.kind].color} min-w-0 transition-opacity hover:opacity-80`}
              style={{
                flex: `${interval.durationMs} 1 0%`,
                // Keep the context role on one cyan/teal color. Its estimate
                // status is conveyed by the ~ label and tooltip instead of a
                // second, dimmer teal shade.
                opacity:
                  interval.kind === "context" ? 1 : interval.confidence === "measured" ? 0.9 : 0.55,
              }}
              title={intervalTitle(interval)}
            />
          ))}
          {timing.contextBoundaries.map((boundary) => (
            <div
              key={`context-${boundary.sceneIndex}`}
              aria-hidden="true"
              className="absolute inset-y-0 w-0.5 bg-terminal-context"
              style={{
                left: `${timing.totalMs > 0 ? (boundary.elapsedMs / timing.totalMs) * 100 : 0}%`,
              }}
              title={
                boundary.type === "compaction-summary" && boundary.durationMs !== undefined
                  ? `Compaction boundary; ~${formatActivityDuration(boundary.durationMs)} estimated from the preceding timestamp gap`
                  : `${boundary.type === "compaction-summary" ? "Compaction" : "Context"} boundary; duration not persisted`
              }
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-terminal-context/30 bg-terminal-context-subtle/30 px-3 py-2 text-[10px] font-mono text-terminal-context">
          Context boundaries were recorded, but no timestamp interval is available to size the
          activity strip.
        </div>
      )}

      <span className="sr-only">{accessibleSummary}</span>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {visibleKinds.map((kind) => {
          const meta = ACTIVITY_META[kind];
          const durationMs = totals.find((total) => total.kind === kind)?.durationMs || 0;
          const contextMarkerOnly = kind === "context" && durationMs === 0;
          return (
            <div key={kind} className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-sm ${meta.color}`} />
                <span className={`truncate text-[10px] font-mono ${meta.textColor}`}>
                  {meta.label}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-mono text-terminal-text tabular-nums">
                {contextMarkerOnly
                  ? `${timing.contextBoundaries.length} marker${timing.contextBoundaries.length === 1 ? "" : "s"}`
                  : kind === "context"
                    ? `~${formatActivityDuration(durationMs)}`
                    : formatActivityDuration(durationMs)}
                {!contextMarkerOnly && (
                  <span className="ml-1 text-[9px] text-terminal-dimmer">
                    {formatActivityPercent(durationMs, timing.totalMs)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-sm bg-terminal-thinking" />
            <span className="truncate text-[10px] font-mono text-terminal-thinking">Thinking</span>
          </div>
          <div className="mt-1 text-[11px] font-mono text-terminal-text tabular-nums">
            {timing.thinkingCount > 0 ? `${timing.thinkingCount} folded` : "—"}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-mono text-terminal-dimmer">
        <span>{timing.intervals.length} timed segments</span>
        <span>{timing.toolCalls} tool calls</span>
        <span>{formatActivityDuration(timing.timestampGapMs)} from timestamp gaps</span>
        <span>{formatActivityDuration(timing.toolDurationMs)} provider-recorded tool time</span>
        {timing.localToolMs > 0 && (
          <span>local tools {formatActivityDuration(timing.localToolMs)}</span>
        )}
        {timing.remoteToolMs > 0 && (
          <span>remote tools {formatActivityDuration(timing.remoteToolMs)}</span>
        )}
        {timing.compactionDurationMs > 0 && (
          <span>
            ~{formatActivityDuration(timing.compactionDurationMs)} estimated compaction time
          </span>
        )}
        {toolCategorySummaries.length > 0 && <span>{toolCategorySummaries.join(" · ")}</span>}
        {timing.unmeasuredToolCalls > 0 && (
          <span>{timing.unmeasuredToolCalls} tool calls without recorded duration</span>
        )}
        {timing.contextBoundaries.length > 0 && (
          <span>
            {timing.contextBoundaries.length} context boundaries; exact start/end not persisted
          </span>
        )}
      </div>
    </div>
  );
}
