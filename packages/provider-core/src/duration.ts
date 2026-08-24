/**
 * Estimate active session duration from message timestamps.
 *
 * When `turn_duration` events are missing (e.g. VS Code extension sessions),
 * we approximate active time by summing gaps between consecutive timestamps,
 * capping each gap at `maxGapMs`.  Gaps larger than the threshold represent
 * idle time (lunch, sleep, context-switch) and are capped to `maxGapMs`.
 */

const DEFAULT_MAX_GAP_MS = 5 * 60 * 1000; // 5 minutes

export interface DurationInterval {
  startMs: number;
  endMs: number;
}

export interface TurnTimingEvent {
  role: "user" | "assistant";
  /** Timestamp at which a user turn starts. */
  startMs?: number;
  /** Latest timestamp observed while an assistant turn is completing. */
  endMs?: number;
}

/**
 * Build one interval per user turn from ordered user/assistant events.
 *
 * An assistant response can be split across several records, so its end is
 * the latest assistant timestamp observed before the next user turn. Missing
 * timestamps intentionally produce no interval instead of a guessed duration.
 */
export function buildTurnDurationIntervals(
  events: readonly TurnTimingEvent[],
): Array<DurationInterval | undefined> {
  const intervals: Array<DurationInterval | undefined> = [];
  let hasCurrentTurn = false;
  let startMs: number | undefined;
  let endMs: number | undefined;

  const finalize = () => {
    intervals.push(toDurationInterval(startMs, endMs));
  };

  for (const event of events) {
    if (event.role === "user") {
      if (hasCurrentTurn) finalize();
      hasCurrentTurn = true;
      startMs = finiteTimestamp(event.startMs);
      endMs = undefined;
      continue;
    }

    if (startMs === undefined) continue;
    const candidateEndMs = finiteTimestamp(event.endMs);
    if (candidateEndMs !== undefined && (endMs === undefined || candidateEndMs > endMs)) {
      endMs = candidateEndMs;
    }
  }

  if (hasCurrentTurn) finalize();
  return intervals;
}

/** Return a valid interval only when both endpoints are finite and ordered. */
export function toDurationInterval(
  startMs: number | undefined,
  endMs: number | undefined,
): DurationInterval | undefined {
  if (startMs === undefined || endMs === undefined) return undefined;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  return { startMs, endMs };
}

/**
 * Sum the union of intervals rather than summing each interval independently.
 *
 * Parallel tool calls and nested agents can cover the same wall-clock range.
 * Merging first prevents those overlapping activities from inflating the
 * session's active duration.
 */
export function sumDurationIntervals(
  intervals: readonly (DurationInterval | undefined)[],
): number | undefined {
  const sorted = intervals
    .filter((interval): interval is DurationInterval => {
      return (
        interval !== undefined &&
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs > interval.startMs
      );
    })
    .map((interval) => ({ ...interval }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (sorted.length === 0) return undefined;

  let active = 0;
  let currentStart = sorted[0].startMs;
  let currentEnd = sorted[0].endMs;

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, next.endMs);
      continue;
    }
    active += currentEnd - currentStart;
    currentStart = next.startMs;
    currentEnd = next.endMs;
  }
  active += currentEnd - currentStart;

  return active > 0 ? active : undefined;
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

export function estimateActiveDuration(
  timestamps: string[],
  maxGapMs = DEFAULT_MAX_GAP_MS,
): number | undefined {
  if (timestamps.length < 2) return undefined;

  const sorted = timestamps
    .map((t) => Date.parse(t))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (sorted.length < 2) return undefined;

  let active = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    active += Math.min(gap, maxGapMs);
  }

  return active > 0 ? active : undefined;
}

/** Return the earliest and latest valid timestamps without assuming input order. */
export function getTimestampBounds(timestamps: Array<string | undefined>): {
  startTime?: string;
  endTime?: string;
} {
  let startTime: string | undefined;
  let endTime: string | undefined;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) continue;
    if (time < startMs) {
      startMs = time;
      startTime = timestamp;
    }
    if (time > endMs) {
      endMs = time;
      endTime = timestamp;
    }
  }

  return { startTime, endTime };
}
