import { describe, expect, it } from "vitest";
import { estimateCost, estimateCostSimple, getModelPricing } from "../src/pricing.js";
import type { TokenUsage } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// getModelPricing — model family detection
// ---------------------------------------------------------------------------
describe("getModelPricing — model family detection", () => {
  it("returns Opus pricing for opus model IDs", () => {
    const p = getModelPricing("claude-opus-4-20250514");
    expect(p.inputRate).toBe(15);
    expect(p.outputRate).toBe(75);
  });

  it("returns Opus pricing for short opus model ID", () => {
    const p = getModelPricing("claude-opus-4-6");
    expect(p.inputRate).toBe(15);
    expect(p.outputRate).toBe(75);
  });

  it("returns Sonnet pricing for sonnet model IDs", () => {
    const p = getModelPricing("claude-sonnet-4-20250514");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("returns Sonnet pricing for short sonnet model ID", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("returns Haiku pricing for haiku model IDs", () => {
    const p = getModelPricing("claude-haiku-4-20250514");
    expect(p.inputRate).toBe(0.8);
    expect(p.outputRate).toBe(4);
  });

  it("returns Haiku pricing for older haiku model", () => {
    const p = getModelPricing("claude-haiku-4-5-20251001");
    expect(p.inputRate).toBe(0.8);
    expect(p.outputRate).toBe(4);
  });

  it("defaults to Sonnet pricing for unknown models", () => {
    const p = getModelPricing("some-unknown-model");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("defaults to Sonnet pricing for empty string", () => {
    const p = getModelPricing("");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("is case-insensitive", () => {
    expect(getModelPricing("Claude-OPUS-4").inputRate).toBe(15);
    expect(getModelPricing("CLAUDE-SONNET-4").inputRate).toBe(3);
    expect(getModelPricing("claude-HAIKU-3").inputRate).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// estimateCostSimple — single model cost
// ---------------------------------------------------------------------------
describe("estimateCostSimple — single model", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  it("calculates Opus cost", () => {
    // 15 * 1M / 1M + 75 * 100K / 1M = 15 + 7.5 = 22.5
    expect(estimateCostSimple(usage, "claude-opus-4-20250514")).toBeCloseTo(22.5, 2);
  });

  it("calculates Sonnet cost", () => {
    // 3 * 1M / 1M + 15 * 100K / 1M = 3 + 1.5 = 4.5
    expect(estimateCostSimple(usage, "claude-sonnet-4-20250514")).toBeCloseTo(4.5, 2);
  });

  it("calculates Haiku cost", () => {
    // 0.8 * 1M / 1M + 4 * 100K / 1M = 0.8 + 0.4 = 1.2
    expect(estimateCostSimple(usage, "claude-haiku-4-20250514")).toBeCloseTo(1.2, 2);
  });

  it("includes cache creation and read tokens", () => {
    const withCache: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    };
    // Sonnet: create=3.75 + read=0.3 = 4.05
    expect(estimateCostSimple(withCache, "claude-sonnet-4-20250514")).toBeCloseTo(4.05, 2);
  });

  it("returns 0 for zero token usage", () => {
    const zero: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    expect(estimateCostSimple(zero, "claude-opus-4-20250514")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateCost — per-model breakdown (the key improvement)
// ---------------------------------------------------------------------------
describe("estimateCost — per-model breakdown", () => {
  it("sums cost across multiple models", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-opus-4-20250514": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-sonnet-4-20250514": {
        inputTokens: 500_000,
        outputTokens: 200_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    // Opus: 15*1 + 75*0.1 = 22.5
    // Sonnet: 3*0.5 + 15*0.2 = 1.5 + 3 = 4.5
    // Total: 27.0
    expect(estimateCost(usageByModel)).toBeCloseTo(27.0, 2);
  });

  it("gives different result than single-model assumption", () => {
    // This is the core bug fix: if we assumed all tokens were Opus,
    // we'd get a different (wrong) cost than per-model calculation.
    const usageByModel: Record<string, TokenUsage> = {
      "claude-opus-4-20250514": {
        inputTokens: 100_000,
        outputTokens: 50_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-haiku-4-5-20251001": {
        inputTokens: 900_000,
        outputTokens: 450_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    const perModel = estimateCost(usageByModel);

    // If we wrongly assumed all-Opus:
    const totalInput = 1_000_000;
    const totalOutput = 500_000;
    const allOpus = estimateCostSimple(
      {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-opus-4-20250514",
    );

    // Per-model should be significantly cheaper because Haiku is much cheaper
    // Opus: 15*0.1 + 75*0.05 = 1.5 + 3.75 = 5.25
    // Haiku: 0.8*0.9 + 4*0.45 = 0.72 + 1.8 = 2.52
    // Total: 7.77
    expect(perModel).toBeCloseTo(7.77, 1);
    // All-Opus would be: 15*1 + 75*0.5 = 52.5
    expect(allOpus).toBeCloseTo(52.5, 1);
    expect(perModel).toBeLessThan(allOpus);
  });

  it("handles single model in breakdown", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-sonnet-4-20250514": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    expect(estimateCost(usageByModel)).toBeCloseTo(4.5, 2);
  });

  it("handles empty breakdown", () => {
    expect(estimateCost({})).toBe(0);
  });

  it("handles three different models", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-opus-4-6": {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-sonnet-4-6": {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-haiku-4-5-20251001": {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    // Opus: 15*0.1 + 75*0.01 = 1.5 + 0.75 = 2.25
    // Sonnet: 3*0.1 + 15*0.01 = 0.3 + 0.15 = 0.45
    // Haiku: 0.8*0.1 + 4*0.01 = 0.08 + 0.04 = 0.12
    // Total: 2.82
    expect(estimateCost(usageByModel)).toBeCloseTo(2.82, 2);
  });
});
