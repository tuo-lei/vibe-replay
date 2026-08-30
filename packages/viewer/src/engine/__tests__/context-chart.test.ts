import { describe, expect, it } from "vitest";
import type { TurnStat } from "../../types";
import {
  computeCacheHitRate,
  computeContextLayers,
  findContextDrops,
  getContextScale,
  getTurnStat,
  orderedTurnStats,
  turnCacheHitRate,
} from "../context-chart";

function ts(partial: Partial<TurnStat> = {}): TurnStat {
  return { turnIndex: 0, ...partial } as TurnStat;
}

describe("computeContextLayers", () => {
  it("returns zeroed layers for a turn missing tokenUsage", () => {
    const [layer] = computeContextLayers([ts({ contextTokens: 5000 })]);
    expect(layer).toEqual({
      cacheRead: 0,
      uncached: 0,
      cacheCreate: 0,
      total: 0,
      rawCr: 0,
      rawSum: 0,
      hasData: false,
    });
  });

  it("returns zeroed layers when contextTokens is 0", () => {
    const [layer] = computeContextLayers([
      ts({
        contextTokens: 0,
        tokenUsage: {
          cacheReadTokens: 100,
          cacheCreationTokens: 10,
          inputTokens: 5,
          outputTokens: 0,
        },
      }),
    ]);
    expect(layer.hasData).toBe(false);
    expect(layer.total).toBe(0);
  });

  it("returns zeroed layers when every tokenUsage component is 0", () => {
    const [layer] = computeContextLayers([
      ts({
        contextTokens: 500,
        tokenUsage: {
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
    ]);
    expect(layer.hasData).toBe(false);
  });

  it("scales the three components so they sum exactly to contextTokens", () => {
    // tokenUsage accumulates across sub-calls (huge), contextTokens is the
    // max single-call prompt — this is the real-world Claude Code shape.
    const [layer] = computeContextLayers([
      ts({
        contextTokens: 100_000,
        tokenUsage: {
          cacheReadTokens: 900_000,
          cacheCreationTokens: 90_000,
          inputTokens: 10_000,
          outputTokens: 0,
        },
      }),
    ]);
    expect(layer.hasData).toBe(true);
    expect(layer.cacheRead + layer.uncached + layer.cacheCreate).toBeCloseTo(100_000, 2);
    // Ratio preserved: 90% cacheRead, 9% cacheCreate, 1% uncached
    expect(layer.cacheRead / 100_000).toBeCloseTo(0.9, 4);
    expect(layer.cacheCreate / 100_000).toBeCloseTo(0.09, 4);
    expect(layer.uncached / 100_000).toBeCloseTo(0.01, 4);
  });

  it("preserves raw tokenUsage counts for hit-rate math", () => {
    const [layer] = computeContextLayers([
      ts({
        contextTokens: 50_000,
        tokenUsage: {
          cacheReadTokens: 800_000,
          cacheCreationTokens: 50_000,
          inputTokens: 150_000,
          outputTokens: 0,
        },
      }),
    ]);
    expect(layer.rawCr).toBe(800_000);
    expect(layer.rawSum).toBe(1_000_000);
  });
});

describe("turn-stat joins and context drops", () => {
  it("orders sparse stats by turnIndex and looks them up by semantic index", () => {
    const stats = [
      ts({ turnIndex: 3, contextTokens: 300 }),
      ts({ turnIndex: 1, contextTokens: 100 }),
    ];

    expect(orderedTurnStats(stats).map((stat) => stat.turnIndex)).toEqual([1, 3]);
    expect(getTurnStat(stats, 1)?.contextTokens).toBe(100);
    expect(getTurnStat(stats, 2)).toBeUndefined();
  });

  it("only reports drops between adjacent observed turns", () => {
    expect(
      findContextDrops([
        ts({ turnIndex: 0, contextTokens: 1000 }),
        ts({ turnIndex: 1, contextTokens: 400 }),
        ts({ turnIndex: 3, contextTokens: 100 }),
      ]),
    ).toEqual([
      {
        position: 0,
        beforeTurnIndex: 0,
        afterTurnIndex: 1,
        before: 1000,
        after: 400,
      },
    ]);
  });

  it("uses the configured limit as the semantic limit while keeping an over-limit peak visible", () => {
    expect(getContextScale([ts({ contextTokens: 415_242 })], 272_000)).toEqual({
      peak: 415_242,
      limit: 272_000,
      displayMax: 415_242,
    });
    expect(getContextScale([ts({ contextTokens: 150_000 })])).toEqual({
      peak: 150_000,
      displayMax: 150_000,
    });
  });
});

describe("computeCacheHitRate", () => {
  it("returns 0 when there is no usable data at all", () => {
    const layers = computeContextLayers([ts({ contextTokens: 0 })]);
    expect(computeCacheHitRate(layers)).toBe(0);
  });

  it("uses raw token counts (never exceeds 100% on real inputs)", () => {
    // Reproduces the 825% bug scenario: cacheReadTokens far exceeds
    // contextTokens because it sums across sub-calls. The old code divided
    // cacheRead/contextTokens and blew past 100%; raw-sum math bounds it.
    const layers = computeContextLayers([
      ts({
        contextTokens: 86_553,
        tokenUsage: {
          cacheReadTokens: 2_983_058,
          cacheCreationTokens: 192_288,
          inputTokens: 48,
          outputTokens: 0,
        },
      }),
    ]);
    const rate = computeCacheHitRate(layers);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(100);
    // cacheRead(2,983,058) / sum(2,983,058 + 192,288 + 48) ≈ 93.94%
    expect(rate).toBeCloseTo(93.94, 1);
  });

  it("computes a weighted average across multiple turns", () => {
    const layers = computeContextLayers([
      ts({
        contextTokens: 1000,
        tokenUsage: {
          cacheReadTokens: 900,
          cacheCreationTokens: 50,
          inputTokens: 50,
          outputTokens: 0,
        },
      }),
      ts({
        contextTokens: 1000,
        tokenUsage: {
          cacheReadTokens: 100,
          cacheCreationTokens: 400,
          inputTokens: 500,
          outputTokens: 0,
        },
      }),
    ]);
    // Combined: cacheRead 1000 / sum 2000 = 50%
    expect(computeCacheHitRate(layers)).toBeCloseTo(50, 4);
  });

  it("ignores no-data turns (they contribute 0 to both numerator and denominator)", () => {
    const layers = computeContextLayers([
      ts({ contextTokens: 0 }), // no data
      ts({
        contextTokens: 1000,
        tokenUsage: {
          cacheReadTokens: 800,
          cacheCreationTokens: 100,
          inputTokens: 100,
          outputTokens: 0,
        },
      }),
    ]);
    expect(computeCacheHitRate(layers)).toBeCloseTo(80, 4);
  });
});

describe("turnCacheHitRate", () => {
  it("returns 0 for a no-data layer", () => {
    const [layer] = computeContextLayers([ts({ contextTokens: 0 })]);
    expect(turnCacheHitRate(layer)).toBe(0);
  });

  it("returns cacheRead / rawSum for a normal turn", () => {
    const [layer] = computeContextLayers([
      ts({
        contextTokens: 1000,
        tokenUsage: {
          cacheReadTokens: 700,
          cacheCreationTokens: 100,
          inputTokens: 200,
          outputTokens: 0,
        },
      }),
    ]);
    expect(turnCacheHitRate(layer)).toBeCloseTo(70, 4);
  });
});
