/**
 * Tests for improvements derived from Claude Code source analysis:
 * - isCompactSummary flag detection
 * - isMeta filtering
 * - stop_reason / truncation tracking
 * - service_tier extraction
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import { transformToReplay } from "../src/transform.js";

const FIXTURE = join(import.meta.dirname, "fixtures/claude-code-source-insights.jsonl");

describe("Claude Code source insights: isCompactSummary flag", () => {
  it("detects compaction summary via isCompactSummary flag", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const compactionTurns = result.turns.filter(
      (t) => t.role === "user" && t.subtype === "compaction-summary",
    );
    expect(compactionTurns).toHaveLength(1);
    expect((compactionTurns[0].blocks[0] as any).text).toContain("This session is being continued");
  });

  it("transforms compaction summary to compaction-summary scene", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    const compactionScenes = replay.scenes.filter((s) => s.type === "compaction-summary");
    expect(compactionScenes).toHaveLength(1);
  });
});

describe("Claude Code source insights: isMeta as context-injection", () => {
  it("captures isMeta messages as context-injection turns", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const injections = result.turns.filter(
      (t) => t.role === "user" && t.subtype === "context-injection",
    );
    expect(injections).toHaveLength(1);
    expect((injections[0].blocks[0] as any).text).toContain("Base directory for this skill");
  });

  it("does not include isMeta messages in regular user turns", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const regularTurns = result.turns.filter((t) => t.role === "user" && !t.subtype);
    const texts = regularTurns.map((t) => (t.blocks[0] as any).text);
    expect(texts).toContain("Build the auth system");
    expect(texts).toContain("Continue building the auth middleware");
    expect(regularTurns).toHaveLength(2);
  });

  it("transforms context-injection to scene with specific injectionType", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    const injectionScenes = replay.scenes.filter((s) => s.type === "context-injection");
    expect(injectionScenes).toHaveLength(1);
    expect(
      injectionScenes[0].type === "context-injection" && injectionScenes[0].injectionType,
    ).toBe("skill:auth-skill");
  });

  it("extracts skillsUsed from isMeta skill injections", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.skillsUsed).toEqual(["auth-skill"]);
  });

  it("passes skillsUsed through to ReplaySession", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    expect(replay.meta.skillsUsed).toEqual(["auth-skill"]);
  });
});

describe("Claude Code source insights: stop_reason tracking", () => {
  it("marks truncated responses with stopReason", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const truncated = result.turns.filter(
      (t) => t.role === "assistant" && t.stopReason === "max_tokens",
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0].messageId).toBe("msg_si3");
  });

  it("does not mark end_turn responses as truncated", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const nonTruncated = result.turns.filter(
      (t) => t.role === "assistant" && !t.stopReason && t.messageId,
    );
    expect(nonTruncated.length).toBeGreaterThanOrEqual(2);
  });

  it("reports truncatedResponses count", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.truncatedResponses).toBe(1);
  });

  it("transform sets isTruncated on text-response scene", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    const truncatedScene = replay.scenes.find(
      (s) => s.type === "text-response" && (s as any).isTruncated === true,
    );
    expect(truncatedScene).toBeDefined();
    expect(truncatedScene!.type === "text-response" && truncatedScene!.content).toContain(
      "running out of tok",
    );
  });

  it("passes truncatedResponses through to ReplaySession", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    expect(replay.meta.truncatedResponses).toBe(1);
  });
});

describe("Claude Code source insights: service_tier extraction", () => {
  it("extracts service_tier from usage data", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.serviceTier).toBe("standard");
  });

  it("passes serviceTier through to ReplaySession", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    expect(replay.meta.serviceTier).toBe("standard");
  });
});

describe("Claude Code source insights: combined parsing", () => {
  it("produces correct scene count", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    // Expected scenes:
    // 1. user-prompt "Build the auth system"
    // 2. thinking
    // 3. text-response "I'll build..."
    // 4. tool-call Bash
    // 5. text-response (truncated) "Now I'll write..."
    // 6. compaction-summary
    // 7. context-injection (skill)
    // 8. user-prompt "Continue building..."
    // 9. text-response "I'll continue..."
    expect(replay.scenes).toHaveLength(9);
    expect(replay.meta.stats.userPrompts).toBe(2);
  });

  it("calculates token usage correctly across all messages", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.tokenUsage).toBeDefined();
    // Total across 4 assistant messages:
    // input: 1000+1200+1500+800 = 4500
    // output: 200+50+16384+100 = 16734
    // cache_creation: 500+0+0+200 = 700
    // cache_read: 8000+9500+10000+5000 = 32500
    expect(result.tokenUsage!.inputTokens).toBe(4500);
    expect(result.tokenUsage!.outputTokens).toBe(16734);
    expect(result.tokenUsage!.cacheCreationTokens).toBe(700);
    expect(result.tokenUsage!.cacheReadTokens).toBe(32500);
  });
});
