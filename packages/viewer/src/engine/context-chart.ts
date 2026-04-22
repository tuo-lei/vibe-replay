import type { TurnStat } from "../types";

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
