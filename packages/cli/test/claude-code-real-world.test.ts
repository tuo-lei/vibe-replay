import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import { transformToReplay } from "../src/transform.js";

const fixture = (name: string) => join(import.meta.dirname, `fixtures/${name}`);
const REAL = fixture("claude-code-real-world-edges.jsonl");
const EDGE = fixture("claude-code-edge-cases.jsonl");

// ---------------------------------------------------------------------------
// Bug fix: customTitle field
// ---------------------------------------------------------------------------
describe("Claude Code parser — customTitle field (bug fix)", () => {
  it("reads customTitle from real JSONL format", async () => {
    const result = await parseClaudeCodeSession(REAL);
    expect(result.title).toBe("Real world edge cases");
  });

  it("reads customTitle from edge-cases fixture (was using wrong field)", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    expect(result.title).toBe("Fix authentication flow");
  });

  it("falls back to title field for compatibility", async () => {
    // The old format used `title` — parser should still support it
    const result = await parseClaudeCodeSession(fixture("claude-code-session.jsonl"));
    // This fixture doesn't have custom-title, so title should be undefined
    expect(result.title).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unhandled top-level types are silently skipped
// ---------------------------------------------------------------------------
describe("Claude Code parser — unknown top-level types", () => {
  it("skips queue-operation without crashing", async () => {
    const result = await parseClaudeCodeSession(REAL);
    expect(result.sessionId).toBe("real-edge-001");
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("queued prompt");
  });

  it("skips last-prompt without crashing", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("some last prompt");
  });

  it("skips pr-link without crashing", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("github.com");
  });
});

// ---------------------------------------------------------------------------
// Unhandled system subtypes are silently skipped
// ---------------------------------------------------------------------------
describe("Claude Code parser — system subtypes", () => {
  it("skips local_command subtype", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("Session renamed");
  });

  it("skips bridge_status subtype", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("bridge ready");
  });

  it("skips stop_hook_summary subtype", async () => {
    const result = await parseClaudeCodeSession(REAL);
    // Should not throw and should parse normally
    expect(result.turns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// New system-generated message filters
// ---------------------------------------------------------------------------
describe("Claude Code parser — extended system message filtering", () => {
  it("filters <bash-input> messages", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .filter(Boolean);
    expect(userTexts).not.toContain(expect.stringContaining("<bash-input>"));
  });

  it("filters <bash-stdout> messages", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .filter(Boolean);
    expect(userTexts).not.toContain(expect.stringContaining("<bash-stdout>"));
  });

  it("filters <command-message> messages", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const userTexts = result.turns
      .filter((t) => t.role === "user")
      .flatMap((t) => t.blocks)
      .map((b) => (b as any).text)
      .filter(Boolean);
    expect(userTexts).not.toContain(expect.stringContaining("<command-message>"));
  });

  it("keeps real user prompts alongside filtered messages", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const userTurns = result.turns.filter((t) => t.role === "user" && !t.subtype);
    // Only the real prompt — isMeta skill injection is now correctly filtered out
    expect(userTurns.length).toBe(1);
    const texts = userTurns.map((t) => (t.blocks[0] as any).text);
    expect(texts).toContain("Implement the feature");
  });
});

// ---------------------------------------------------------------------------
// isMeta / sourceToolUseID messages (skill injections)
// ---------------------------------------------------------------------------
describe("Claude Code parser — isMeta skill injection messages", () => {
  it("captures isMeta messages as context-injection turns", async () => {
    const result = await parseClaudeCodeSession(REAL);
    // isMeta messages are captured with subtype "context-injection", not as regular user turns
    const injections = result.turns.filter(
      (t) => t.role === "user" && t.subtype === "context-injection",
    );
    expect(injections.length).toBeGreaterThanOrEqual(1);
    const injectionText = injections
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text);
    expect(injectionText.some((t: string) => t.includes("Base directory for this skill"))).toBe(
      true,
    );
  });

  it("does not include isMeta messages in regular user turns", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const regularTurns = result.turns.filter((t) => t.role === "user" && !t.subtype);
    const regularText = regularTurns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text);
    expect(regularText.some((t: string) => t.includes("Base directory for this skill"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Compaction with isCompactSummary flag
// ---------------------------------------------------------------------------
describe("Claude Code parser — compaction with isCompactSummary flag", () => {
  it("detects compaction summary via content prefix (real data has flag too)", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const compactionTurns = result.turns.filter(
      (t) => t.role === "user" && t.subtype === "compaction-summary",
    );
    expect(compactionTurns.length).toBe(1);
    expect((compactionTurns[0].blocks[0] as any).text).toContain("This session is being continued");
  });
});

// ---------------------------------------------------------------------------
// Synthetic model messages
// ---------------------------------------------------------------------------
describe("Claude Code parser — synthetic messages", () => {
  it("parses synthetic API error messages as assistant turns", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const allText = assistantTurns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text);
    expect(allText.some((t: string) => t.includes("API Error"))).toBe(true);
  });

  it("parses synthetic no-response messages", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const allText = assistantTurns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text);
    expect(allText).toContain("No response requested.");
  });

  it("synthetic messages with zero usage do not corrupt token totals", async () => {
    const result = await parseClaudeCodeSession(REAL);
    expect(result.tokenUsage).toBeDefined();
    // msg_asst1 has real usage: input=100, output=50 (last), cache_create=500, cache_read=200
    // msg_asst2 has no usage field
    // msg_synth1 has zero usage: all 0
    // msg_synth2 has zero usage: input=0, output=0
    // msg_truncated: input=50, output=32000
    // Totals should be dominated by real messages, not corrupted by synthetics
    expect(result.tokenUsage!.inputTokens).toBe(150); // 100 + 0 + 0 + 50
    expect(result.tokenUsage!.outputTokens).toBe(32050); // 50 + 0 + 0 + 32000
    expect(result.tokenUsage!.cacheCreationTokens).toBe(500); // 500 + 0 + 0
    expect(result.tokenUsage!.cacheReadTokens).toBe(200); // 200 + 0 + 0
  });
});

// ---------------------------------------------------------------------------
// Extended usage fields don't break parsing
// ---------------------------------------------------------------------------
describe("Claude Code parser — extended usage fields", () => {
  it("parses successfully with cache_creation, service_tier, server_tool_use fields", async () => {
    const result = await parseClaudeCodeSession(REAL);
    // Parser should extract standard fields and ignore extended ones
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.inputTokens).toBeGreaterThan(0);
    expect(result.tokenUsage!.cacheCreationTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool results with is_error: true
// ---------------------------------------------------------------------------
describe("Claude Code parser — error tool results", () => {
  it("captures error tool results the same as success results", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const bashBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_use" && (b as any).name === "Bash");
    expect(bashBlock).toBeDefined();
    expect((bashBlock as any)._result).toContain("permission denied");
  });

  it("transform produces tool-call scene from error result", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const replay = transformToReplay(result, "claude-code", "~/test/realproject");
    const bashScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    if (bashScene?.type === "tool-call") {
      expect(bashScene.result).toContain("permission denied");
    }
  });
});

// ---------------------------------------------------------------------------
// Empty tool input and empty tool result
// ---------------------------------------------------------------------------
describe("Claude Code parser — empty tool input/result", () => {
  it("handles tool_use with empty {} input (MCP tools)", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const mcpBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find(
        (b) =>
          b.type === "tool_use" && (b as any).name === "mcp__claude-in-chrome__tabs_context_mcp",
      );
    expect(mcpBlock).toBeDefined();
    expect((mcpBlock as any).input).toEqual({});
  });

  it("handles empty string tool result", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const mcpBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find(
        (b) =>
          b.type === "tool_use" && (b as any).name === "mcp__claude-in-chrome__tabs_context_mcp",
      );
    expect(mcpBlock).toBeDefined();
    expect((mcpBlock as any)._result).toBe("");
  });

  it("transform handles empty input MCP tool gracefully", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const replay = transformToReplay(result, "claude-code", "~/test/realproject");
    const mcpScene = replay.scenes.find(
      (s) => s.type === "tool-call" && s.toolName === "mcp__claude-in-chrome__tabs_context_mcp",
    );
    expect(mcpScene).toBeDefined();
    if (mcpScene?.type === "tool-call") {
      expect(mcpScene.input).toEqual({});
      expect(mcpScene.result).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Thinking blocks with signature field
// ---------------------------------------------------------------------------
describe("Claude Code parser — thinking block signature", () => {
  it("extracts thinking text and strips signature", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const thinkingBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect((thinkingBlock as any).thinking).toBe("Let me analyze this request.");
    // signature should not be preserved in the parsed output
    expect((thinkingBlock as any).signature).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// max_tokens stop_reason (truncated response)
// ---------------------------------------------------------------------------
describe("Claude Code parser — max_tokens truncation", () => {
  it("still parses truncated thinking block from max_tokens response", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    // msg_truncated has a thinking block with max_tokens stop_reason
    const truncatedTurn = assistantTurns.find((t) => t.messageId === "msg_truncated");
    expect(truncatedTurn).toBeDefined();
    const thinking = truncatedTurn!.blocks.find((b) => b.type === "thinking");
    expect(thinking).toBeDefined();
    expect((thinking as any).thinking).toContain("truncated");
  });

  it("includes max_tokens message usage in totals", async () => {
    const result = await parseClaudeCodeSession(REAL);
    // msg_truncated has output_tokens: 32000
    expect(result.tokenUsage!.outputTokens).toBeGreaterThanOrEqual(32000);
  });
});

// ---------------------------------------------------------------------------
// Transform: synthetic messages produce text-response scenes
// ---------------------------------------------------------------------------
describe("Claude Code → transform — synthetic and edge scenes", () => {
  it("produces text-response scene from API error synthetic message", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const replay = transformToReplay(result, "claude-code", "~/test/realproject");
    const apiErrorScene = replay.scenes.find(
      (s) => s.type === "text-response" && s.content.includes("API Error"),
    );
    expect(apiErrorScene).toBeDefined();
  });

  it("overall scene structure is reasonable for mixed input", async () => {
    const result = await parseClaudeCodeSession(REAL);
    const replay = transformToReplay(result, "claude-code", "~/test/realproject");
    expect(replay.scenes.length).toBeGreaterThan(0);
    expect(replay.meta.stats.sceneCount).toBe(replay.scenes.length);
    expect(replay.meta.stats.userPrompts).toBeGreaterThanOrEqual(1);

    // Should have at least: user-prompt, thinking, text-response, tool-call
    const types = new Set(replay.scenes.map((s) => s.type));
    expect(types.has("user-prompt")).toBe(true);
    expect(types.has("text-response")).toBe(true);
    expect(types.has("tool-call")).toBe(true);
  });
});
