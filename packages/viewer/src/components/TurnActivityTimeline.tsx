import { useMemo } from "react";
import { sceneDuration } from "../engine/scene-timing";
import type { Scene, TurnStat } from "../types";

type ActivityKind = "user" | "tool" | "response" | "context" | "thinking";

interface ActivitySegment {
  kind: Exclude<ActivityKind, "thinking">;
  durationMs: number;
  sceneIndex: number;
  recorded: boolean;
}

interface ActivityTotal {
  durationMs: number;
  count: number;
  recordedMs: number;
  estimatedMs: number;
}

interface ContextMarker {
  sceneIndex: number;
  elapsedMs: number;
}

const ACTIVITY_META: Record<ActivityKind, { label: string; color: string; textColor: string }> = {
  user: { label: "User / idle", color: "bg-terminal-user", textColor: "text-terminal-user" },
  tool: { label: "Tool execution", color: "bg-terminal-tool", textColor: "text-terminal-tool" },
  response: {
    label: "LLM wait / response",
    color: "bg-terminal-response",
    textColor: "text-terminal-response",
  },
  context: {
    label: "Compaction / context",
    color: "bg-terminal-context",
    textColor: "text-terminal-context",
  },
  thinking: {
    label: "Thinking",
    color: "bg-terminal-thinking",
    textColor: "text-terminal-thinking",
  },
};

function emptyTotals(): Record<ActivityKind, ActivityTotal> {
  return {
    user: { durationMs: 0, count: 0, recordedMs: 0, estimatedMs: 0 },
    tool: { durationMs: 0, count: 0, recordedMs: 0, estimatedMs: 0 },
    response: { durationMs: 0, count: 0, recordedMs: 0, estimatedMs: 0 },
    context: { durationMs: 0, count: 0, recordedMs: 0, estimatedMs: 0 },
    thinking: { durationMs: 0, count: 0, recordedMs: 0, estimatedMs: 0 },
  };
}

function timestampMs(scene: Scene): number | undefined {
  if (!scene.timestamp) return undefined;
  const parsed = Date.parse(scene.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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

function addTotal(
  totals: Record<ActivityKind, ActivityTotal>,
  kind: ActivityKind,
  durationMs: number,
  recorded: boolean,
): void {
  totals[kind].durationMs += durationMs;
  totals[kind].count++;
  if (recorded) totals[kind].recordedMs += durationMs;
  else totals[kind].estimatedMs += durationMs;
}

export default function TurnActivityTimeline({
  scenes,
  turnStats,
}: {
  scenes: readonly Scene[];
  turnStats?: readonly TurnStat[];
}) {
  const { segments, totals, totalMs, measuredMs, contextMarkers, thinkingCount, turnOverheadMs } =
    useMemo(() => {
      const nextTotals = emptyTotals();
      const nextSegments: ActivitySegment[] = [];
      const nextContextMarkers: ContextMarker[] = [];
      let cursorMs: number | undefined;
      let measuredMs = 0;
      let elapsedMs = 0;
      let thinkingCount = 0;

      const addSegment = (
        kind: Exclude<ActivityKind, "thinking">,
        durationMs: number,
        sceneIndex: number,
        recorded: boolean,
      ) => {
        const safeDurationMs = Math.max(1, durationMs);
        nextSegments.push({ kind, durationMs: safeDurationMs, sceneIndex, recorded });
        addTotal(nextTotals, kind, safeDurationMs, recorded);
        elapsedMs += safeDurationMs;
        if (recorded) measuredMs += safeDurationMs;
      };

      scenes.forEach((scene, sceneIndex) => {
        const atMs = timestampMs(scene);

        // A gap ending at a user prompt is user idle/input time. A gap ending at
        // an assistant event is model/network wait plus response generation; the
        // persisted record does not expose exact first-token timing.
        if (atMs !== undefined && cursorMs !== undefined && atMs > cursorMs) {
          const kind: Exclude<ActivityKind, "thinking"> =
            scene.type === "user-prompt"
              ? "user"
              : scene.type === "compaction-summary" || scene.type === "context-injection"
                ? "context"
                : "response";
          addSegment(kind, atMs - cursorMs, sceneIndex, true);
        }

        if (scene.type === "tool-call") {
          const recorded = scene.durationMs !== undefined && scene.durationMs > 0;
          const durationMs = recorded ? scene.durationMs! : sceneDuration(scene, 1);
          addSegment("tool", durationMs, sceneIndex, recorded);
          if (atMs !== undefined) {
            const startMs = Math.max(cursorMs ?? atMs, atMs);
            cursorMs = startMs + durationMs;
          }
        } else {
          if (scene.type === "thinking") thinkingCount++;
          if (scene.type === "compaction-summary" || scene.type === "context-injection") {
            nextContextMarkers.push({ sceneIndex, elapsedMs });
          }
          if (atMs !== undefined) cursorMs = Math.max(cursorMs ?? atMs, atMs);
        }
      });

      return {
        segments: nextSegments,
        totals: nextTotals,
        totalMs: elapsedMs,
        measuredMs,
        contextMarkers: nextContextMarkers,
        thinkingCount,
        turnOverheadMs:
          turnStats && turnStats.some((turn) => turn.durationMs !== undefined)
            ? Math.max(
                0,
                turnStats.reduce((sum, turn) => sum + (turn.durationMs || 0), 0) -
                  nextTotals.tool.recordedMs,
              )
            : undefined,
      };
    }, [scenes, turnStats]);

  if (segments.length === 0 || totalMs <= 0) return null;

  return (
    <div className="rounded-xl bg-terminal-surface p-4 shadow-layer-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="ui-section-title-strong">Activity timeline</div>
          <p className="mt-1 text-[10px] font-mono text-terminal-dimmer">
            Recorded event gaps and tool runtimes, left to right. LLM wait is not exact TTFT.
          </p>
        </div>
        <span className="shrink-0 text-[10px] font-mono text-terminal-dim tabular-nums">
          {formatActivityDuration(totalMs)} timeline span
        </span>
      </div>

      <div
        className="relative mt-4 flex h-5 overflow-hidden rounded-full bg-terminal-surface-2"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- composite timeline visualization, not an image asset
        role="img"
        aria-label="Activity timeline showing user idle, tool execution, LLM wait, and context gaps"
      >
        {segments.map((segment) => (
          <div
            key={`${segment.sceneIndex}-${segment.kind}`}
            className={`${ACTIVITY_META[segment.kind].color} min-w-0 transition-opacity hover:opacity-80`}
            style={{ flex: `${segment.durationMs} 1 0%`, opacity: segment.recorded ? 0.9 : 0.35 }}
            title={`${ACTIVITY_META[segment.kind].label} · ${formatActivityDuration(segment.durationMs)}${segment.recorded ? " · measured" : " · estimated tool fallback"}`}
          />
        ))}
        {contextMarkers.map((marker) => (
          <div
            key={`context-${marker.sceneIndex}`}
            className="absolute inset-y-0 w-0.5 bg-terminal-context"
            style={{ left: `${totalMs > 0 ? (marker.elapsedMs / totalMs) * 100 : 0}%` }}
            title="Compaction/context boundary; duration not persisted"
          />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        {(Object.keys(ACTIVITY_META) as ActivityKind[]).map((kind) => {
          const meta = ACTIVITY_META[kind];
          const total = totals[kind];
          const hasTime = total.durationMs > 0;
          return (
            <div key={kind} className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-sm ${meta.color}`} />
                <span className={`truncate text-[10px] font-mono ${meta.textColor}`}>
                  {meta.label}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-mono text-terminal-text tabular-nums">
                {hasTime
                  ? formatActivityDuration(total.durationMs)
                  : kind === "context" && contextMarkers.length > 0
                    ? "marker only"
                    : kind === "thinking" && thinkingCount > 0
                      ? "folded"
                      : "—"}
                {hasTime && (
                  <span className="ml-1 text-[9px] text-terminal-dimmer">
                    {formatActivityPercent(total.durationMs, totalMs)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] font-mono text-terminal-dimmer">
        <span>{segments.length} timed segments</span>
        <span>{totals.tool.count} tool calls</span>
        <span>{formatActivityDuration(measuredMs)} timestamp/tool time</span>
        {turnOverheadMs !== undefined && (
          <span>{formatActivityDuration(turnOverheadMs)} non-tool turn overhead</span>
        )}
        {totals.tool.estimatedMs > 0 && (
          <span>{formatActivityDuration(totals.tool.estimatedMs)} estimated tool fallback</span>
        )}
        {thinkingCount > 0 && <span>{thinkingCount} thinking blocks folded into LLM wait</span>}
        {contextMarkers.length > 0 && <span>{contextMarkers.length} context boundaries</span>}
      </div>
    </div>
  );
}
