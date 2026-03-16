import type { TokenUsage } from "./providers/types.js";

interface ModelPricing {
  inputRate: number; // $/M tokens
  outputRate: number;
  cacheCreateRate: number;
  cacheReadRate: number;
}

// Per-model pricing in USD per million tokens (base rates).
// Tiered pricing (higher rates above 200k tokens) exists per-request but we only
// have aggregate token counts, so we use base rates which match per-message reality
// (individual messages rarely exceed the 200k threshold).
// Source: LiteLLM model pricing data (used by ccusage).
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.6/4.5
  "opus-4-new": {
    inputRate: 5,
    outputRate: 25,
    cacheCreateRate: 6.25,
    cacheReadRate: 0.5,
  },
  // Opus 4.1 and earlier
  opus: {
    inputRate: 15,
    outputRate: 75,
    cacheCreateRate: 18.75,
    cacheReadRate: 1.5,
  },
  // Sonnet 4.6/4.5 — same rates as earlier Sonnet today; separate entry for future divergence
  "sonnet-4-new": {
    inputRate: 3,
    outputRate: 15,
    cacheCreateRate: 3.75,
    cacheReadRate: 0.3,
  },
  // Sonnet 3.7/3.5 and earlier
  sonnet: {
    inputRate: 3,
    outputRate: 15,
    cacheCreateRate: 3.75,
    cacheReadRate: 0.3,
  },
  // Haiku 4.5/4.6
  "haiku-4-5": {
    inputRate: 1,
    outputRate: 5,
    cacheCreateRate: 1.25,
    cacheReadRate: 0.1,
  },
  // Haiku 3.5 and earlier
  haiku: {
    inputRate: 0.8,
    outputRate: 4,
    cacheCreateRate: 1,
    cacheReadRate: 0.08,
  },
};

const DEFAULT_PRICING = MODEL_PRICING.sonnet;

/**
 * Resolve pricing for a model ID string.
 * Checks specific version patterns first, then falls back to family names.
 */
export function getModelPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();
  // Opus: 4.6/4.5 → new pricing, 4.1 and earlier → legacy
  if (lower.includes("opus-4-6") || lower.includes("opus-4-5")) return MODEL_PRICING["opus-4-new"];
  if (lower.includes("opus")) return MODEL_PRICING.opus;
  // Sonnet: 4.6/4.5 → new pricing with tiered, earlier → standard
  if (lower.includes("sonnet-4-6") || lower.includes("sonnet-4-5"))
    return MODEL_PRICING["sonnet-4-new"];
  if (lower.includes("sonnet")) return MODEL_PRICING.sonnet;
  // Haiku: 4.5/4.6 → new pricing, 3.5 and earlier → legacy
  if (lower.includes("haiku-4-5") || lower.includes("haiku-4-6")) return MODEL_PRICING["haiku-4-5"];
  if (lower.includes("haiku")) return MODEL_PRICING.haiku;
  return DEFAULT_PRICING;
}

// Non-Claude context window limits. Claude models are handled by name detection below.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gemini-2": 1_000_000,
  "gemini-1.5": 1_000_000,
  deepseek: 128_000,
};

/**
 * Resolve context window limit for a model ID string.
 * Returns undefined if model is unknown.
 */
export function getModelContextLimit(model: string): number | undefined {
  const lower = model.toLowerCase();
  if (lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    // All Claude models: 200K
    return 200_000;
  }
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lower.includes(key)) return limit;
  }
  return undefined;
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
