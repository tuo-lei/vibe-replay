import type { TurnStat } from "../types";

export interface ContextDrop {
  /** Position in the ordered turn-stat list immediately before the drop. */
  position: number;
  beforeTurnIndex: number;
  afterTurnIndex: number;
  before: number;
  after: number;
}

/**
 * Return turn stats in their semantic prompt order without mutating the
 * provider-owned array. Older providers may omit turns, so callers must use
 * `turnIndex` rather than the array position when joining these stats to
 * rendered prompts. Providers that expose `segmentIndex` use that for
 * ordering continuation segments within one user prompt.
 */
export function orderedTurnStats(turnStats: readonly TurnStat[]): TurnStat[] {
  return [...turnStats].sort(
    (a, b) => (a.segmentIndex ?? a.turnIndex) - (b.segmentIndex ?? b.turnIndex),
  );
}

/** Look up a turn's metrics without assuming that every turn has a stat row. */
export function getTurnStat(
  turnStats: readonly TurnStat[] | undefined,
  turnIndex: number,
): TurnStat | undefined {
  return turnStats?.find((stat) => stat.turnIndex === turnIndex);
}

/**
 * Find large context drops between adjacent, observed turn stats.
 *
 * These are deliberately called context drops rather than compactions: a
 * provider may persist compaction events without exposing enough per-turn
 * data for a drop, and a drop alone does not prove that compaction occurred.
 */
export function findContextDrops(turnStats: readonly TurnStat[]): ContextDrop[] {
  const ordered = orderedTurnStats(turnStats);
  const drops: ContextDrop[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const current = ordered[i];
    const next = ordered[i + 1];
    const before = current.contextTokens || 0;
    const after = next.contextTokens || 0;
    // Do not infer across an omitted turn/segment. The missing row may contain
    // the actual reset or may make two unrelated observations look adjacent.
    const adjacent =
      current.segmentIndex !== undefined && next.segmentIndex !== undefined
        ? next.segmentIndex === current.segmentIndex + 1
        : next.turnIndex === current.turnIndex + 1;
    if (adjacent && before > 0 && after > 0 && after < before * 0.5) {
      drops.push({
        position: i,
        beforeTurnIndex: current.turnIndex,
        afterTurnIndex: next.turnIndex,
        before,
        after,
      });
    }
  }
  return drops;
}

export interface ContextScale {
  peak: number;
  /** The configured/provider-supplied limit, if one is available. */
  limit?: number;
  /** Y-axis ceiling used only to keep all observed values visible. */
  displayMax: number;
}

export function getContextScale(
  turnStats: readonly TurnStat[],
  contextLimit?: number,
): ContextScale {
  const peak = Math.max(...turnStats.map((stat) => stat.contextTokens || 0), 0);
  const limit = contextLimit && contextLimit > 0 ? contextLimit : undefined;
  return {
    peak,
    ...(limit ? { limit } : {}),
    displayMax: Math.max(peak, limit || 0),
  };
}

export interface ContextLayer {
  /** Scaled cache-read component (sums to contextTokens alongside siblings). */
  cacheRead: number;
  /** Scaled uncached-input component. */
  uncached: number;
  /** Scaled cache-creation component. */
  cacheCreate: number;
  /** Scaled total = per-turn contextTokens when hasData, else 0. */
  total: number;
  /** Raw tokenUsage.cacheReadTokens (unscaled). */
  rawCr: number;
  /** Raw tokenUsage.cacheReadTokens + cacheCreationTokens + inputTokens (unscaled). */
  rawSum: number;
  /** Whether this turn has usable breakdown data (tokenUsage + contextTokens + nonzero rawSum). */
  hasData: boolean;
}

/**
 * Per-turn breakdown layers for the context-window stacked chart.
 *
 * `tokenUsage` fields are summed across every API sub-call in a turn, while
 * `contextTokens` is the max single-call prompt size — different scales. To
 * keep the stacked areas comparable to the context-window curve we scale the
 * three components proportionally so they sum to `contextTokens`. The raw
 * counts are preserved for tooltip numbers and hit-rate math.
 *
 * Turns missing `tokenUsage` (or with `contextTokens === 0` / `rawSum === 0`)
 * get zeroed layers so the stacked fill drops to 0 at those positions; the
 * caller is expected to overlay a neutral "no breakdown" marker instead of
 * letting the orange cache-write fill read as 100%.
 */
export function computeContextLayers(turnStats: TurnStat[]): ContextLayer[] {
  return turnStats.map((t) => {
    const ctx = t.contextTokens || 0;
    const cr = t.tokenUsage?.cacheReadTokens || 0;
    const cc = t.tokenUsage?.cacheCreationTokens || 0;
    const inp = t.tokenUsage?.inputTokens || 0;
    const rawSum = cr + cc + inp;
    const hasData = !!t.tokenUsage && ctx > 0 && rawSum > 0;
    if (!hasData) {
      return {
        cacheRead: 0,
        uncached: 0,
        cacheCreate: 0,
        total: 0,
        rawCr: cr,
        rawSum,
        hasData,
      };
    }
    const scale = ctx / rawSum;
    return {
      cacheRead: cr * scale,
      uncached: inp * scale,
      cacheCreate: cc * scale,
      total: ctx,
      rawCr: cr,
      rawSum,
      hasData,
    };
  });
}

/**
 * Overall cache-hit percentage across a set of layers.
 *
 * Formula: `sum(cacheReadTokens) / sum(cacheReadTokens + cacheCreationTokens +
 * inputTokens)`. Uses raw (unscaled) tokenUsage counts so the ratio reflects
 * real API behavior rather than the chart-scaled display values.
 */
export function computeCacheHitRate(layers: ContextLayer[]): number {
  let cr = 0;
  let sum = 0;
  for (const l of layers) {
    cr += l.rawCr;
    sum += l.rawSum;
  }
  return sum > 0 ? (cr / sum) * 100 : 0;
}

/**
 * Per-turn cache-hit percentage (same formula as {@link computeCacheHitRate}).
 * Returns 0 if the turn has no usable tokenUsage data.
 */
export function turnCacheHitRate(layer: ContextLayer): number {
  return layer.rawSum > 0 ? (layer.rawCr / layer.rawSum) * 100 : 0;
}
