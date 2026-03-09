import { describe, expect, it } from "vitest";
import { estimateCost, estimateCostSimple, getModelPricing } from "../src/pricing.js";
import type { TokenUsage } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// getModelPricing — model family + version detection
// ---------------------------------------------------------------------------
describe("getModelPricing — model family detection", () => {
  it("returns Opus 4.6 pricing for opus-4-6 model ID", () => {
    const p = getModelPricing("claude-opus-4-6");
    expect(p.inputRate).toBe(5);
    expect(p.outputRate).toBe(25);
    expect(p.cacheCreateRate).toBe(6.25);
    expect(p.cacheReadRate).toBe(0.5);
  });

  it("returns Opus 4.5 pricing for opus-4-5 model ID", () => {
    const p = getModelPricing("claude-opus-4-5-20250514");
    expect(p.inputRate).toBe(5);
    expect(p.outputRate).toBe(25);
  });

  it("returns legacy Opus pricing for opus-4-20250514 (4.1)", () => {
    const p = getModelPricing("claude-opus-4-20250514");
    expect(p.inputRate).toBe(15);
    expect(p.outputRate).toBe(75);
    expect(p.cacheCreateRate).toBe(18.75);
    expect(p.cacheReadRate).toBe(1.5);
  });

  it("returns Sonnet 4.6 pricing for sonnet-4-6 model ID", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("returns Sonnet 4.5 pricing for sonnet-4-5 model ID", () => {
    const p = getModelPricing("claude-sonnet-4-5-20250514");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("returns legacy Sonnet pricing for sonnet-3-7", () => {
    const p = getModelPricing("claude-3-7-sonnet-20250219");
    expect(p.inputRate).toBe(3);
    expect(p.outputRate).toBe(15);
  });

  it("returns Haiku 4.5 pricing for haiku-4-5 model ID", () => {
    const p = getModelPricing("claude-haiku-4-5-20251001");
    expect(p.inputRate).toBe(1);
    expect(p.outputRate).toBe(5);
    expect(p.cacheCreateRate).toBe(1.25);
    expect(p.cacheReadRate).toBe(0.1);
  });

  it("returns legacy Haiku pricing for haiku-3-5", () => {
    const p = getModelPricing("claude-3-5-haiku-20241022");
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
    expect(getModelPricing("Claude-OPUS-4-6").inputRate).toBe(5);
    expect(getModelPricing("CLAUDE-SONNET-4-6").inputRate).toBe(3);
    expect(getModelPricing("claude-HAIKU-4-5").inputRate).toBe(1);
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

  it("calculates Opus 4.6 cost", () => {
    // 5 * 1M / 1M + 25 * 100K / 1M = 5 + 2.5 = 7.5
    expect(estimateCostSimple(usage, "claude-opus-4-6")).toBeCloseTo(7.5, 2);
  });

  it("calculates legacy Opus cost", () => {
    // 15 * 1M / 1M + 75 * 100K / 1M = 15 + 7.5 = 22.5
    expect(estimateCostSimple(usage, "claude-opus-4-20250514")).toBeCloseTo(22.5, 2);
  });

  it("calculates Sonnet cost", () => {
    // 3 * 1M / 1M + 15 * 100K / 1M = 3 + 1.5 = 4.5
    expect(estimateCostSimple(usage, "claude-sonnet-4-6")).toBeCloseTo(4.5, 2);
  });

  it("calculates Haiku 4.5 cost", () => {
    // 1 * 1M / 1M + 5 * 100K / 1M = 1 + 0.5 = 1.5
    expect(estimateCostSimple(usage, "claude-haiku-4-5-20251001")).toBeCloseTo(1.5, 2);
  });

  it("includes cache creation and read tokens", () => {
    const withCache: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    };
    // Sonnet: create=3.75 + read=0.3 = 4.05
    expect(estimateCostSimple(withCache, "claude-sonnet-4-6")).toBeCloseTo(4.05, 2);
  });

  it("returns 0 for zero token usage", () => {
    const zero: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    expect(estimateCostSimple(zero, "claude-opus-4-6")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateCost — per-model breakdown
// ---------------------------------------------------------------------------
describe("estimateCost — per-model breakdown", () => {
  it("sums cost across multiple models", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-opus-4-6": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-sonnet-4-6": {
        inputTokens: 500_000,
        outputTokens: 200_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    // Opus 4.6: 5*1 + 25*0.1 = 5 + 2.5 = 7.5
    // Sonnet: 3*0.5 + 15*0.2 = 1.5 + 3 = 4.5
    // Total: 12.0
    expect(estimateCost(usageByModel)).toBeCloseTo(12.0, 2);
  });

  it("gives different result than single-model assumption", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-opus-4-6": {
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

    // Opus 4.6: 5*0.1 + 25*0.05 = 0.5 + 1.25 = 1.75
    // Haiku 4.5: 1*0.9 + 5*0.45 = 0.9 + 2.25 = 3.15
    // Total: 4.90
    expect(perModel).toBeCloseTo(4.9, 1);

    // All-Opus would be much more expensive
    const allOpus = estimateCostSimple(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      "claude-opus-4-6",
    );
    expect(perModel).toBeLessThan(allOpus);
  });

  it("handles single model in breakdown", () => {
    const usageByModel: Record<string, TokenUsage> = {
      "claude-sonnet-4-6": {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    // 3*1 + 15*0.1 = 4.5
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
    // Opus 4.6: 5*0.1 + 25*0.01 = 0.5 + 0.25 = 0.75
    // Sonnet: 3*0.1 + 15*0.01 = 0.3 + 0.15 = 0.45
    // Haiku 4.5: 1*0.1 + 5*0.01 = 0.1 + 0.05 = 0.15
    // Total: 1.35
    expect(estimateCost(usageByModel)).toBeCloseTo(1.35, 2);
  });
});
