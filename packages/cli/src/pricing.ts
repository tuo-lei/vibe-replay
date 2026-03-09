import type { TokenUsage } from "./providers/types.js";

interface ModelPricing {
  inputRate: number; // $/M tokens
  outputRate: number;
  cacheCreateRate: number;
  cacheReadRate: number;
}

// Per-model pricing in USD per million tokens.
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputRate: 15, outputRate: 75, cacheCreateRate: 18.75, cacheReadRate: 1.5 },
  sonnet: { inputRate: 3, outputRate: 15, cacheCreateRate: 3.75, cacheReadRate: 0.3 },
  haiku: { inputRate: 0.8, outputRate: 4, cacheCreateRate: 1, cacheReadRate: 0.08 },
};

const DEFAULT_PRICING = MODEL_PRICING.sonnet;

/**
 * Resolve pricing for a model ID string.
 * Matches against known model family names (opus, sonnet, haiku).
 */
export function getModelPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_PRICING.opus;
  if (lower.includes("haiku")) return MODEL_PRICING.haiku;
  if (lower.includes("sonnet")) return MODEL_PRICING.sonnet;
  return DEFAULT_PRICING;
}

/** Calculate cost in USD for a single token usage bucket at a given pricing. */
function computeCost(usage: TokenUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens * pricing.inputRate +
      usage.outputTokens * pricing.outputRate +
      usage.cacheCreationTokens * pricing.cacheCreateRate +
      usage.cacheReadTokens * pricing.cacheReadRate) /
    1_000_000
  );
}

/**
 * Estimate total session cost from per-model token usage breakdown.
 * Each entry maps a model ID to its aggregated token usage.
 */
export function estimateCost(usageByModel: Record<string, TokenUsage>): number {
  let total = 0;
  for (const [model, usage] of Object.entries(usageByModel)) {
    total += computeCost(usage, getModelPricing(model));
  }
  return total;
}

/**
 * Estimate cost from a single aggregate TokenUsage + model string.
 * Legacy fallback when per-model breakdown is not available (e.g. Cursor).
 */
export function estimateCostSimple(usage: TokenUsage, model: string): number {
  return computeCost(usage, getModelPricing(model));
}
