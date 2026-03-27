/**
 * Estimate active session duration from message timestamps.
 *
 * When `turn_duration` events are missing (e.g. VS Code extension sessions),
 * we approximate active time by summing gaps between consecutive timestamps,
 * capping each gap at `maxGapMs`.  Gaps larger than the threshold represent
 * idle time (lunch, sleep, context-switch) and are capped to `maxGapMs`.
 */

const DEFAULT_MAX_GAP_MS = 5 * 60 * 1000; // 5 minutes

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
