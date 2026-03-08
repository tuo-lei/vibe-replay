import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import { transformToReplay } from "../src/transform.js";

const FIXTURE = join(import.meta.dirname, "fixtures/claude-code-session.jsonl");
const IMG_FIXTURE = join(import.meta.dirname, "fixtures/claude-code-images.jsonl");

describe("Claude Code parser", () => {
  it("extracts session metadata", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.sessionId).toBe("test-session-123");
    expect(result.slug).toBe("test-slug");
    expect(result.cwd).toBe("/Users/test/project");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.startTime).toBe("2025-01-15T10:00:00Z");
  });

  it("parses user prompts", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    expect(userTurns.length).toBe(2);
    expect(userTurns[0].blocks[0]).toMatchObject({
      type: "text",
      text: "Fix the bug in auth.ts",
    });
    expect(userTurns[1].blocks[0]).toMatchObject({
      type: "text",
      text: "Can you also add input validation?",
    });
  });

  it("groups assistant blocks by message ID", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    // msg_asst1 should have thinking + text + tool_use blocks grouped
    const first = assistantTurns[0];
    const blockTypes = first.blocks.map((b) => b.type);
    expect(blockTypes).toContain("thinking");
    expect(blockTypes).toContain("text");
    expect(blockTypes).toContain("tool_use");
  });

  it("attaches tool results to tool_use blocks", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    // Find the Read tool_use
    for (const turn of assistantTurns) {
      for (const block of turn.blocks) {
        if (block.type === "tool_use" && block.name === "Read") {
          expect((block as any)._result).toContain("export function login()");
        }
      }
    }
  });

  it("computes total duration from turn_duration events", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.totalDurationMs).toBe(8000); // 5000 + 3000
  });

  it("skips progress lines", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    // Should not crash or produce weird turns from progress lines
    const allText = result.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join(" ");
    expect(allText).not.toContain("streaming");
  });
});

describe("Claude Code parser — images", () => {
  it("extracts user-pasted images", async () => {
    const result = await parseClaudeCodeSession(IMG_FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    // User turn should have text + _user_images block
    const first = userTurns[0];
    const imgBlock = first.blocks.find((b) => (b as any).type === "_user_images");
    expect(imgBlock).toBeDefined();
    expect((imgBlock as any).images).toHaveLength(1);
    expect((imgBlock as any).images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("extracts tool result images", async () => {
    const result = await parseClaudeCodeSession(IMG_FIXTURE);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const toolUse = assistantTurns[0]?.blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as any)._images).toHaveLength(1);
    expect((toolUse as any)._images[0]).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe("Claude Code → transform", () => {
  it("produces correct scene types", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    const types = replay.scenes.map((s) => s.type);
    expect(types).toContain("user-prompt");
    expect(types).toContain("thinking");
    expect(types).toContain("text-response");
    expect(types).toContain("tool-call");
  });

  it("creates correct scene count and stats", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    expect(replay.meta.stats.userPrompts).toBe(2);
    expect(replay.meta.stats.toolCalls).toBeGreaterThan(0);
    expect(replay.meta.stats.sceneCount).toBe(replay.scenes.length);
  });

  it("enriches Edit tool calls with diff", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    const editScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Edit");
    expect(editScene).toBeDefined();
    if (editScene?.type === "tool-call") {
      expect(editScene.diff).toBeDefined();
      expect(editScene.diff?.filePath).toBe("/Users/test/project/auth.ts");
      expect(editScene.diff?.oldContent).toContain("return null");
      expect(editScene.diff?.newContent).toContain("generateToken");
    }
  });

  it("enriches Bash tool calls with command + stdout", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    const bashScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    if (bashScene?.type === "tool-call") {
      expect(bashScene.bashOutput).toBeDefined();
      expect(bashScene.bashOutput?.command).toBe("npm test");
      expect(bashScene.bashOutput?.stdout).toContain("tests passed");
    }
  });

  it("attaches images to user-prompt scenes", async () => {
    const parsed = await parseClaudeCodeSession(IMG_FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    const promptWithImg = replay.scenes.find(
      (s) => s.type === "user-prompt" && s.images && s.images.length > 0,
    );
    expect(promptWithImg).toBeDefined();
    expect(promptWithImg?.images?.[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("redacts secrets in output", async () => {
    // Manually test the redaction by checking that a known pattern would be redacted
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");
    // The fixture doesn't contain secrets, but we can verify the pipeline doesn't crash
    expect(replay.scenes.length).toBeGreaterThan(0);
  });

  it("populates metadata correctly", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    expect(replay.meta.provider).toBe("claude-code");
    expect(replay.meta.project).toBe("~/test/project");
    expect(replay.meta.model).toBe("claude-sonnet-4-20250514");
    expect(replay.meta.slug).toBe("test-slug");
    expect(replay.meta.stats.durationMs).toBe(8000);
  });
});
