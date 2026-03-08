import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import { transformToReplay } from "../src/transform.js";

const fixture = (name: string) => join(import.meta.dirname, `fixtures/${name}`);

// ---------------------------------------------------------------------------
// Multi-file sessions (Claude Code /resume creates new JSONL files)
// ---------------------------------------------------------------------------
describe("Claude Code parser — multi-file sessions", () => {
  const FILE1 = fixture("claude-code-multifile-1.jsonl");
  const FILE2 = fixture("claude-code-multifile-2.jsonl");

  it("accepts string[] and merges turns from both files", async () => {
    const result = await parseClaudeCodeSession([FILE1, FILE2]);
    expect(result.turns.length).toBeGreaterThan(2);
    const userTurns = result.turns.filter((t) => t.role === "user");
    expect(userTurns.length).toBe(2);
    expect((userTurns[0].blocks[0] as any).text).toBe("Refactor the database module");
    expect((userTurns[1].blocks[0] as any).text).toBe("Now add error handling to the queries");
  });

  it("extracts metadata from first file only", async () => {
    const result = await parseClaudeCodeSession([FILE1, FILE2]);
    expect(result.sessionId).toBe("multi-session-001");
    expect(result.slug).toBe("multi-slug");
    expect(result.cwd).toBe("/Users/test/multiproject");
  });

  it("accumulates duration from both files", async () => {
    const result = await parseClaudeCodeSession([FILE1, FILE2]);
    expect(result.totalDurationMs).toBe(6000); // 4000 + 2000
  });

  it("pairs tool results across file boundaries", async () => {
    const result = await parseClaudeCodeSession([FILE1, FILE2]);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const editBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_use" && (b as any).name === "Edit");
    expect(editBlock).toBeDefined();
    expect((editBlock as any)._result).toBe("File edited successfully.");
  });

  it("produces valid replay from multi-file parse", async () => {
    const parsed = await parseClaudeCodeSession([FILE1, FILE2]);
    const replay = transformToReplay(parsed, "claude-code", "~/test/multiproject");
    expect(replay.scenes.length).toBeGreaterThan(0);
    expect(replay.meta.stats.userPrompts).toBe(2);
    const editScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Edit");
    expect(editScene).toBeDefined();
    expect(editScene!.type).toBe("tool-call");
    expect(editScene!.type === "tool-call" && editScene!.diff?.filePath).toContain("db.ts");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: malformed JSON, system messages, empty content, compaction
// ---------------------------------------------------------------------------
describe("Claude Code parser — edge cases", () => {
  const EDGE = fixture("claude-code-edge-cases.jsonl");

  it("skips malformed JSON lines gracefully", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    // Should not throw and should still parse valid lines
    expect(result.sessionId).toBe("edge-session-001");
  });

  it("extracts custom title", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    expect(result.title).toBe("Fix authentication flow");
  });

  it("filters all system-generated user messages", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    const userTexts = userTurns.map((t) => (t.blocks[0] as any).text);
    // Only real user prompt + compaction summary should survive
    expect(userTexts).not.toContain("[Request interrupted by user");
    expect(userTexts).not.toContain("<command-name>some command</command-name>");
    expect(userTexts).not.toContain("<local-command-caveat>some caveat</local-command-caveat>");
    expect(userTexts).not.toContain("<local-command-stdout>output here</local-command-stdout>");
    expect(userTexts).not.toContain("<task-notification>notification here</task-notification>");
  });

  it("keeps real user prompts", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    const userTurns = result.turns.filter((t) => t.role === "user" && !t.subtype);
    expect(userTurns.length).toBe(1);
    expect((userTurns[0].blocks[0] as any).text).toBe("This is the real user prompt");
  });

  it("detects compaction summary messages", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    const compactionTurns = result.turns.filter(
      (t) => t.role === "user" && t.subtype === "compaction-summary",
    );
    expect(compactionTurns.length).toBe(1);
    expect((compactionTurns[0].blocks[0] as any).text).toContain("This session is being continued");
  });

  it("records compaction events from compact_boundary", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    expect(result.compactions).toBeDefined();
    expect(result.compactions).toHaveLength(1);
    expect(result.compactions![0].trigger).toBe("context_limit");
    expect(result.compactions![0].preTokens).toBe(50000);
  });

  it("skips progress lines", async () => {
    const result = await parseClaudeCodeSession(EDGE);
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("subagent streaming progress");
  });

  it("transform skips empty/whitespace text and thinking blocks", async () => {
    const parsed = await parseClaudeCodeSession(EDGE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/edgeproject");
    // Whitespace-only text and thinking should not produce scenes
    const scenes = replay.scenes;
    for (const scene of scenes) {
      if (scene.type === "text-response" || scene.type === "thinking") {
        expect(scene.content.trim()).not.toBe("");
      }
    }
  });

  it("transform creates compaction-summary scene type", async () => {
    const parsed = await parseClaudeCodeSession(EDGE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/edgeproject");
    const compactionScene = replay.scenes.find((s) => s.type === "compaction-summary");
    expect(compactionScene).toBeDefined();
    expect(compactionScene!.content).toContain("continued");
  });

  it("populates compactions in replay metadata", async () => {
    const parsed = await parseClaudeCodeSession(EDGE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/edgeproject");
    expect(replay.meta.compactions).toHaveLength(1);
    expect(replay.meta.compactions![0].trigger).toBe("context_limit");
  });
});

// ---------------------------------------------------------------------------
// Empty / minimal input
// ---------------------------------------------------------------------------
describe("Claude Code parser — empty input", () => {
  const EMPTY = fixture("claude-code-empty.jsonl");

  it("handles empty file without crashing", async () => {
    const result = await parseClaudeCodeSession(EMPTY);
    expect(result.turns).toHaveLength(0);
    expect(result.sessionId).toBe("");
  });

  it("transform produces empty replay from empty parse", async () => {
    const parsed = await parseClaudeCodeSession(EMPTY);
    const replay = transformToReplay(parsed, "claude-code", "~/empty");
    expect(replay.scenes).toHaveLength(0);
    expect(replay.meta.stats.sceneCount).toBe(0);
    expect(replay.meta.stats.userPrompts).toBe(0);
    expect(replay.meta.stats.toolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Token usage deduplication
// ---------------------------------------------------------------------------
describe("Claude Code parser — token usage", () => {
  const TOKEN = fixture("claude-code-token-usage.jsonl");

  it("deduplicates token usage by message ID (last value wins)", async () => {
    const result = await parseClaudeCodeSession(TOKEN);
    expect(result.tokenUsage).toBeDefined();
    // msg_a1 appears twice: usage should be from the LAST line (30 output, not 10)
    // msg_a2 adds: 200 input, 50 output, 0 cache_create, 80 cache_read
    // Total: input=100+200=300, output=30+50=80, cache_create=50+0=50, cache_read=0+80=80
    expect(result.tokenUsage!.inputTokens).toBe(300);
    expect(result.tokenUsage!.outputTokens).toBe(80);
    expect(result.tokenUsage!.cacheCreationTokens).toBe(50);
    expect(result.tokenUsage!.cacheReadTokens).toBe(80);
  });

  it("transform computes cost estimate for sonnet model", async () => {
    const parsed = await parseClaudeCodeSession(TOKEN);
    const replay = transformToReplay(parsed, "claude-code", "~/test/tokenproject");
    expect(replay.meta.stats.costEstimate).toBeDefined();
    expect(replay.meta.stats.costEstimate).toBeGreaterThan(0);
    expect(replay.meta.stats.tokenUsage).toEqual(parsed.tokenUsage);
  });
});

// ---------------------------------------------------------------------------
// ToolSearch filtering (sourceToolAssistantUUID)
// ---------------------------------------------------------------------------
describe("Claude Code parser — ToolSearch response filtering", () => {
  const TOOLSEARCH = fixture("claude-code-toolsearch-filter.jsonl");

  it("filters out ToolSearch automated responses from user turns", async () => {
    const result = await parseClaudeCodeSession(TOOLSEARCH);
    const userTurns = result.turns.filter((t) => t.role === "user");
    // msg_toolsearch_result has sourceToolAssistantUUID → should be filtered
    // msg_mixed has text "Also check the env files" → should be kept
    const userTexts = userTurns.map((t) =>
      t.blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text)
        .join(""),
    );
    expect(userTexts).toContain("Search for the config file");
    expect(userTexts).toContain("Also check the env files");
    expect(userTexts).not.toContain("Found: config.ts, config.json");
  });

  it("still captures tool results from ToolSearch for pairing", async () => {
    const result = await parseClaudeCodeSession(TOOLSEARCH);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const toolUse = assistantTurns.flatMap((t) => t.blocks).find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as any)._result).toContain("config.ts");
  });
});

// ---------------------------------------------------------------------------
// Write tool enrichment
// ---------------------------------------------------------------------------
describe("Claude Code → transform — Write tool", () => {
  const WRITE = fixture("claude-code-write-tool.jsonl");

  it("enriches Write tool calls with diff (empty oldContent)", async () => {
    const parsed = await parseClaudeCodeSession(WRITE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/writeproject");
    const writeScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Write");
    expect(writeScene).toBeDefined();
    expect(writeScene!.type).toBe("tool-call");
    expect(writeScene!.type === "tool-call" && writeScene!.diff?.oldContent).toBe("");
    expect(writeScene!.type === "tool-call" && writeScene!.diff?.newContent).toContain(
      "formatDate",
    );
    expect(writeScene!.type === "tool-call" && writeScene!.diff?.filePath).toContain("helpers.ts");
  });

  it("enriches Bash tool with command and stdout", async () => {
    const parsed = await parseClaudeCodeSession(WRITE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/writeproject");
    const bashScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    expect(bashScene!.type).toBe("tool-call");
    expect(bashScene!.type === "tool-call" && bashScene!.bashOutput?.command).toContain("npm test");
    expect(bashScene!.type === "tool-call" && bashScene!.bashOutput?.stdout).toContain(
      "2 tests passed",
    );
  });
});

// ---------------------------------------------------------------------------
// Secret redaction in transform pipeline
// ---------------------------------------------------------------------------
describe("Claude Code → transform — secret redaction", () => {
  const SECRETS = fixture("claude-code-secrets.jsonl");

  it("redacts API keys in tool results", async () => {
    const parsed = await parseClaudeCodeSession(SECRETS);
    const replay = transformToReplay(parsed, "claude-code", "~/test/secretproject");
    const readScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Read");
    expect(readScene).toBeDefined();
    expect(readScene!.type).toBe("tool-call");
    const result = readScene!.type === "tool-call" ? readScene!.result : "";
    // OpenAI key
    expect(result).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result).toContain("[REDACTED]");
    // GitHub token
    expect(result).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    // AWS key
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // Database URL with credentials
    expect(result).not.toContain("supersecretpassword");
    // Slack token
    expect(result).not.toContain("xoxb-1234567890-abcdefghij");
  });

  it("redacts secrets in assistant text responses", async () => {
    const parsed = await parseClaudeCodeSession(SECRETS);
    const replay = transformToReplay(parsed, "claude-code", "~/test/secretproject");
    const textScenes = replay.scenes.filter((s) => s.type === "text-response");
    const allText = textScenes.map((s) => s.content).join(" ");
    expect(allText).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(allText).toContain("[REDACTED]");
  });

  it("redacts emails but preserves domain", async () => {
    const parsed = await parseClaudeCodeSession(SECRETS);
    const replay = transformToReplay(parsed, "claude-code", "~/test/secretproject");
    const allContent = replay.scenes.map((s) => s.content).join(" ");
    expect(allContent).not.toContain("admin@example.com");
    expect(allContent).toContain("[REDACTED]@example.com");
  });

  it("redacts JWTs in Bash tool command", async () => {
    const parsed = await parseClaudeCodeSession(SECRETS);
    const replay = transformToReplay(parsed, "claude-code", "~/test/secretproject");
    const bashScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    expect(bashScene!.type).toBe("tool-call");
    const cmd = bashScene!.type === "tool-call" ? bashScene!.bashOutput?.command : "";
    expect(cmd).not.toContain("eyJhbGciOiJIUzI1NiI");
    expect(cmd).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Multiple tool_use blocks in the same assistant message
// ---------------------------------------------------------------------------
describe("Claude Code parser — multiple tools in one message", () => {
  const MULTI = fixture("claude-code-multiple-tools.jsonl");

  it("groups multiple tool_use blocks under same message ID", async () => {
    const result = await parseClaudeCodeSession(MULTI);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    // msg_a1 has text + 2 Read tool_use blocks
    const firstAssistant = assistantTurns[0];
    const toolUseBlocks = firstAssistant.blocks.filter((b) => b.type === "tool_use");
    expect(toolUseBlocks.length).toBe(2);
    expect((toolUseBlocks[0] as any).name).toBe("Read");
    expect((toolUseBlocks[1] as any).name).toBe("Read");
  });

  it("pairs each tool result to correct tool_use by ID", async () => {
    const result = await parseClaudeCodeSession(MULTI);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const firstAssistant = assistantTurns[0];
    const toolBlocks = firstAssistant.blocks.filter((b) => b.type === "tool_use") as any[];
    expect(toolBlocks[0]._result).toContain("const x = 1");
    expect(toolBlocks[1]._result).toContain("export const helper");
  });

  it("transform creates separate tool-call scenes for each", async () => {
    const parsed = await parseClaudeCodeSession(MULTI);
    const replay = transformToReplay(parsed, "claude-code", "~/test/multitool");
    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    // 2 Read + 2 Edit = 4 tool-call scenes
    expect(toolScenes.length).toBe(4);
    const readScenes = toolScenes.filter((s) => s.toolName === "Read");
    const editScenes = toolScenes.filter((s) => s.toolName === "Edit");
    expect(readScenes.length).toBe(2);
    expect(editScenes.length).toBe(2);
  });

  it("Edit scenes have correct diff data", async () => {
    const parsed = await parseClaudeCodeSession(MULTI);
    const replay = transformToReplay(parsed, "claude-code", "~/test/multitool");
    const editScenes = replay.scenes.filter((s) => s.type === "tool-call" && s.toolName === "Edit");
    expect(editScenes[0].type === "tool-call" && editScenes[0].diff?.oldContent).toBe("var y = 2;");
    expect(editScenes[0].type === "tool-call" && editScenes[0].diff?.newContent).toBe(
      "const y = 2;",
    );
    expect(editScenes[1].type === "tool-call" && editScenes[1].diff?.oldContent).toContain(
      "(a) => a + 1",
    );
    expect(editScenes[1].type === "tool-call" && editScenes[1].diff?.newContent).toContain(
      "(a: number): number",
    );
  });
});

// ---------------------------------------------------------------------------
// Cost estimation for different models
// ---------------------------------------------------------------------------
describe("Claude Code → transform — cost estimation", () => {
  it("uses sonnet pricing for sonnet model", async () => {
    const parsed = await parseClaudeCodeSession(fixture("claude-code-token-usage.jsonl"));
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    // Sonnet rates: input=3, output=15, cache_create=3.75, cache_read=0.3 per M tokens
    // 300*3 + 80*15 + 50*3.75 + 80*0.3 = 900 + 1200 + 187.5 + 24 = 2311.5
    // / 1_000_000 = 0.0023115
    const cost = replay.meta.stats.costEstimate!;
    expect(cost).toBeCloseTo(0.0023115, 6);
  });
});

// ---------------------------------------------------------------------------
// Tool result with array content (multiple blocks)
// ---------------------------------------------------------------------------
describe("Claude Code parser — tool result content types", () => {
  // String content is already covered by claude-code-parser.test.ts "attaches tool results"

  it("handles tool result with array of text blocks", async () => {
    // The images fixture has array content in tool_result
    const result = await parseClaudeCodeSession(fixture("claude-code-images.jsonl"));
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const toolBlock = assistantTurns.flatMap((t) => t.blocks).find((b) => b.type === "tool_use");
    // Should extract text from the array content
    expect((toolBlock as any)._result).toContain("Screenshot captured");
  });
});

// ---------------------------------------------------------------------------
// endTime tracking
// ---------------------------------------------------------------------------
describe("Claude Code parser — timestamp tracking", () => {
  it("sets endTime from last turn_duration event", async () => {
    const result = await parseClaudeCodeSession(fixture("claude-code-edge-cases.jsonl"));
    expect(result.endTime).toBe("2025-01-25T08:01:03Z");
  });

  it("sets startTime from file-history-snapshot", async () => {
    const result = await parseClaudeCodeSession(fixture("claude-code-edge-cases.jsonl"));
    expect(result.startTime).toBe("2025-01-25T08:00:00Z");
  });
});
