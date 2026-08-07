import type { TokenUsage } from "@vibe-replay/provider-contract";

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
// Sources:
// - Claude: LiteLLM model pricing data (used by ccusage).
// - GPT-5.x: OpenAI API pricing page (standard rates for context lengths under 270K).
const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.5": {
    inputRate: 5,
    outputRate: 30,
    cacheCreateRate: 5,
    cacheReadRate: 0.5,
  },
  "gpt-5.4": {
    inputRate: 2.5,
    outputRate: 15,
    cacheCreateRate: 2.5,
    cacheReadRate: 0.25,
  },
  "gpt-5.4-mini": {
    inputRate: 0.75,
    outputRate: 4.5,
    cacheCreateRate: 0.75,
    cacheReadRate: 0.075,
  },
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
  // Sonnet 4 (non-4.5/4.6) — same rates per Claude Code source (COST_TIER_3_15)
  "sonnet-4": {
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
  return getKnownModelPricing(model) || DEFAULT_PRICING;
}

/** Resolve pricing only when the model family/version is known. */
export function getKnownModelPricing(model: string): ModelPricing | undefined {
  const lower = model.toLowerCase();
  // GPT-5.x prices from OpenAI's public API pricing table.
  // Check mini before gpt-5.4 so "gpt-5.4-mini" is not shadowed.
  if (lower.includes("gpt-5.4-mini")) return MODEL_PRICING["gpt-5.4-mini"];
  if (lower.includes("gpt-5.5")) return MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5.4")) return MODEL_PRICING["gpt-5.4"];
  // Opus: 4.6/4.5 → new pricing, 4.1 and earlier → legacy
  const opusVersion = parseClaudeVersion(lower, "opus");
  if (isUnsupportedClaudeVersion(opusVersion)) return undefined;
  if (opusVersion?.major === 4 && (opusVersion.minor === 5 || opusVersion.minor === 6))
    return MODEL_PRICING["opus-4-new"];
  if (lower.includes("opus")) return MODEL_PRICING.opus;
  // Sonnet: 4.6/4.5 → new pricing, Sonnet 4 → explicit, earlier → standard
  const sonnetVersion = parseClaudeVersion(lower, "sonnet");
  if (isUnsupportedClaudeVersion(sonnetVersion)) return undefined;
  if (sonnetVersion?.major === 4 && (sonnetVersion.minor === 5 || sonnetVersion.minor === 6))
    return MODEL_PRICING["sonnet-4-new"];
  if (lower.includes("sonnet-4")) return MODEL_PRICING["sonnet-4"];
  if (lower.includes("sonnet")) return MODEL_PRICING.sonnet;
  // Haiku: 4.5/4.6 → new pricing, 3.5 and earlier → legacy
  const haikuVersion = parseClaudeVersion(lower, "haiku");
  if (isUnsupportedClaudeVersion(haikuVersion)) return undefined;
  if (haikuVersion?.major === 4 && (haikuVersion.minor === 5 || haikuVersion.minor === 6))
    return MODEL_PRICING["haiku-4-5"];
  if (lower.includes("haiku")) return MODEL_PRICING.haiku;
  return undefined;
}

interface ClaudeVersion {
  major: number;
  minor?: number;
}

/** Parse both `claude-opus-4-6` and `claude-4-6-opus` version layouts. */
function parseClaudeVersion(
  model: string,
  family: "opus" | "sonnet" | "haiku",
): ClaudeVersion | undefined {
  const versionFirst = model.match(new RegExp(`(?:^|-)claude-(\\d+)(?:-(\\d+))?-${family}(?:-|$)`));
  const familyFirst = model.match(new RegExp(`(?:^|-)${family}-(\\d+)(?:-(\\d+))?(?:-|$)`));
  const match = versionFirst || familyFirst;
  if (!match) return undefined;
  const minorToken = match[2];
  return {
    major: Number(match[1]),
    ...(minorToken && minorToken.length <= 2 ? { minor: Number(minorToken) } : {}),
  };
}

/** Reject future Claude generations and unsupported 4.x minor versions. */
function isUnsupportedClaudeVersion(version: ClaudeVersion | undefined): boolean {
  if (!version) return false;
  if (version.major !== 3 && version.major !== 4) return true;
  return version.major === 4 && version.minor !== undefined && version.minor > 6;
}

// Non-Claude context window limits. Claude models are handled by name detection below.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.5": 270_000,
  "gpt-5.4-mini": 270_000,
  "gpt-5.4": 270_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gemini-2": 1_000_000,
  "gemini-1.5": 1_000_000,
  deepseek: 128_000,
};

/**
 * Resolve context window limit for a model ID string.
 * Returns 200K for all Claude models as a baseline. The viewer dynamically
 * switches to 1M if any turn's token usage exceeds 200K.
 * Returns undefined if model is unknown.
 */
export function getModelContextLimit(model: string): number | undefined {
  const lower = model.toLowerCase();
  if (lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
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

/** Estimate a complete per-model cost only when every model has known pricing. */
export function estimateCostIfKnown(usageByModel: Record<string, TokenUsage>): number | undefined {
  if (Object.keys(usageByModel).length === 0) return undefined;
  let total = 0;
  for (const [model, usage] of Object.entries(usageByModel)) {
    const pricing = getKnownModelPricing(model);
    if (!pricing) return undefined;
    total += computeCost(usage, pricing);
  }
  return total;
}

/** Estimate a single-model cost without applying the legacy Sonnet fallback. */
export function estimateCostSimpleIfKnown(usage: TokenUsage, model: string): number | undefined {
  const pricing = getKnownModelPricing(model);
  return pricing ? computeCost(usage, pricing) : undefined;
}
