import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCostSimple } from "../src/pricing.js";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import type { TokenUsage } from "../src/providers/types.js";
import { transformToReplay } from "../src/transform.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

// ---------------------------------------------------------------------------
// Parser: per-model token usage breakdown
// ---------------------------------------------------------------------------
describe("parser — per-model token usage breakdown", () => {
  it("groups token usage by model from multi-model session", async () => {
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));

    expect(result.tokenUsageByModel).toBeDefined();
    const byModel = result.tokenUsageByModel!;

    // Should have 3 distinct models (opus + sonnet from main file, haiku from subagent file)
    const models = Object.keys(byModel);
    expect(models).toHaveLength(3);
    expect(models).toContain("claude-opus-4-20250514");
    expect(models).toContain("claude-haiku-4-5-20251001");
    expect(models).toContain("claude-sonnet-4-20250514");
  });

  it("reads haiku subagent usage from subagent JSONL files", async () => {
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const byModel = result.tokenUsageByModel!;

    // Subagent file has msg_sub1 and msg_sub2 (haiku):
    // msg_sub1: input:500, output:50, cache_create:8000, cache_read:12000
    // msg_sub2: input:600, output:80, cache_create:0, cache_read:15000
    const haiku = byModel["claude-haiku-4-5-20251001"];
    expect(haiku.inputTokens).toBe(500 + 600);
    expect(haiku.outputTokens).toBe(50 + 80);
    expect(haiku.cacheCreationTokens).toBe(8000 + 0);
    expect(haiku.cacheReadTokens).toBe(12000 + 15000);
  });

  it("subagent file overrides progress line streaming fragments", async () => {
    // The progress line in the main file has partial usage (200/20/4000/6000)
    // for msg_sub1, but the subagent file has the final usage (500/50/8000/12000).
    // The parser should use the subagent file values since it's processed after.
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const byModel = result.tokenUsageByModel!;

    const haiku = byModel["claude-haiku-4-5-20251001"];
    // If progress line was used instead: input would be 200+600=800, not 500+600=1100
    expect(haiku.inputTokens).toBe(1100);
  });

  it("correctly aggregates per-model tokens (deduped by message ID)", async () => {
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const byModel = result.tokenUsageByModel!;

    // msg_a1 (opus): last usage = input:5000, output:800, cache_create:2000, cache_read:1000
    const opus = byModel["claude-opus-4-20250514"];
    expect(opus.inputTokens).toBe(5000);
    expect(opus.outputTokens).toBe(800);
    expect(opus.cacheCreationTokens).toBe(2000);
    expect(opus.cacheReadTokens).toBe(1000);

    // msg_a3 (sonnet): input:8000, output:1500, cache_create:0, cache_read:3000
    const sonnet = byModel["claude-sonnet-4-20250514"];
    expect(sonnet.inputTokens).toBe(8000);
    expect(sonnet.outputTokens).toBe(1500);
    expect(sonnet.cacheCreationTokens).toBe(0);
    expect(sonnet.cacheReadTokens).toBe(3000);
  });

  it("aggregate tokenUsage matches sum of per-model", async () => {
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const total = result.tokenUsage!;
    const byModel = result.tokenUsageByModel!;

    let sumInput = 0;
    let sumOutput = 0;
    let sumCacheCreate = 0;
    let sumCacheRead = 0;
    for (const u of Object.values(byModel)) {
      sumInput += u.inputTokens;
      sumOutput += u.outputTokens;
      sumCacheCreate += u.cacheCreationTokens;
      sumCacheRead += u.cacheReadTokens;
    }

    expect(total.inputTokens).toBe(sumInput);
    expect(total.outputTokens).toBe(sumOutput);
    expect(total.cacheCreationTokens).toBe(sumCacheCreate);
    expect(total.cacheReadTokens).toBe(sumCacheRead);
  });

  it("produces per-model breakdown for single-model session too", async () => {
    const result = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-token-usage.jsonl"));
    const byModel = result.tokenUsageByModel!;

    // All messages use claude-sonnet-4-20250514
    expect(Object.keys(byModel)).toEqual(["claude-sonnet-4-20250514"]);
    expect(byModel["claude-sonnet-4-20250514"].inputTokens).toBe(result.tokenUsage!.inputTokens);
    expect(byModel["claude-sonnet-4-20250514"].outputTokens).toBe(result.tokenUsage!.outputTokens);
  });
});

// ---------------------------------------------------------------------------
// Transform: cost estimation uses per-model pricing
// ---------------------------------------------------------------------------
describe("transform — per-model cost estimation", () => {
  it("uses per-model breakdown for multi-model sessions", async () => {
    const parsed = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const replay = transformToReplay(parsed, "claude-code", "~/test");

    // Calculate expected cost manually (fixture model IDs → pricing):
    // Opus (msg_a1, claude-opus-4-20250514 → legacy Opus $15/$75/$18.75/$1.50):
    //   (5000*15 + 800*75 + 2000*18.75 + 1000*1.5) / 1M = 174000 / 1M = 0.174
    // Haiku (msg_sub1+msg_sub2, claude-haiku-4-5-20251001 → Haiku 4.5 $1/$5/$1.25/$0.10):
    //   (1100*1 + 130*5 + 8000*1.25 + 27000*0.10) / 1M = 14450 / 1M = 0.01445
    // Sonnet (msg_a3, claude-sonnet-4-20250514 → legacy Sonnet $3/$15/$3.75/$0.30):
    //   (8000*3 + 1500*15 + 0 + 3000*0.3) / 1M = 47400 / 1M = 0.0474
    // Total: 0.174 + 0.01445 + 0.0474 = 0.23585
    expect(replay.meta.stats.costEstimate).toBeCloseTo(0.23585, 3);
  });

  it("multi-model cost differs from naive single-model assumption", async () => {
    const parsed = await parseClaudeCodeSession(resolve(FIXTURES, "claude-code-multi-model.jsonl"));
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    const actualCost = replay.meta.stats.costEstimate!;

    // If we naively assumed all tokens were Opus (the "primary" model):
    const naiveOpusCost = estimateCostSimple(parsed.tokenUsage!, "claude-opus-4-20250514");

    // Per-model cost should be less because haiku and sonnet are cheaper
    expect(actualCost).toBeLessThan(naiveOpusCost);
  });

  it("falls back to simple estimation when no per-model breakdown", () => {
    // Simulate a provider (e.g. Cursor) that only provides aggregate tokenUsage
    const parsed = {
      sessionId: "fallback-test",
      slug: "fallback",
      cwd: "/tmp/test",
      model: "claude-sonnet-4-20250514",
      turns: [],
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      } as TokenUsage,
      // No tokenUsageByModel
    };
    const replay = transformToReplay(parsed, "cursor", "~/test");
    // Sonnet: 3*1 + 15*0.1 = 4.5
    expect(replay.meta.stats.costEstimate).toBeCloseTo(4.5, 2);
  });

  it("returns undefined cost when no usage data at all", () => {
    const parsed = {
      sessionId: "no-usage",
      slug: "no-usage",
      cwd: "/tmp/test",
      turns: [],
    };
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    expect(replay.meta.stats.costEstimate).toBeUndefined();
  });
});
