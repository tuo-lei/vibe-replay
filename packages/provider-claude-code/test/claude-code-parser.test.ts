import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@vibe-replay/provider-contract";
import { parseClaudeCodeSession } from "../src/claude-code/parser.js";
import { transformToReplay } from "./helpers/transform.js";

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type UserImagesBlock = Extract<ContentBlock, { type: "_user_images" }>;

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
    const readBlock = assistantTurns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_use" && b.name === "Read");
    expect(readBlock).toBeDefined();
    expect((readBlock as ToolUseBlock)._result).toContain("export function login()");
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
      .map((b) => (b as TextBlock).text)
      .join(" ");
    expect(allText).not.toContain("streaming");
  });

  it("handles newer Claude Code schema-drift fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-claude-schema-"));
    const jsonlPath = join(tempDir, "session.jsonl");
    const lines = [
      {
        type: "system",
        subtype: "init",
        sessionId: "schema-session",
        cwd: "/tmp/project",
        timestamp: "2026-06-02T00:00:00.000Z",
        hookCount: 1,
        hookInfos: [{ command: "echo ok" }],
        hookErrors: [],
        preventedContinuation: false,
        toolUseID: "tool_1",
      },
      {
        type: "user",
        sessionId: "schema-session",
        cwd: "/tmp/project",
        timestamp: "2026-06-02T00:00:01.000Z",
        message: { role: "user", content: "Check schema drift" },
      },
      {
        type: "assistant",
        sessionId: "schema-session",
        cwd: "/tmp/project",
        timestamp: "2026-06-02T00:00:02.000Z",
        attributionMcpServer: "sourcegraph",
        attributionMcpTool: "search",
        attributionSkill: "schema-watch",
        message: {
          role: "assistant",
          id: "msg_schema",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "a.ts" } }],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
      {
        type: "user",
        sessionId: "schema-session",
        cwd: "/tmp/project",
        timestamp: "2026-06-02T00:00:03.000Z",
        sourceToolUseID: "tool_1",
        origin: "tool_result",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file content" }],
        },
      },
      {
        type: "assistant",
        sessionId: "schema-session",
        cwd: "/tmp/project",
        timestamp: "2026-06-02T00:00:04.000Z",
        isApiErrorMessage: true,
        apiErrorStatus: "authentication_error 401",
        message: {
          role: "assistant",
          id: "msg_api",
          model: "<synthetic>",
          content: [{ type: "text", text: "Claude API error" }],
        },
      },
    ];
    await writeFile(
      jsonlPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf-8",
    );

    try {
      const result = await parseClaudeCodeSession(jsonlPath);
      const userTurns = result.turns.filter((turn) => turn.role === "user");
      expect(userTurns).toHaveLength(1);
      expect(result.slug).toBe("");
      expect(result.mcpServersUsed).toEqual(["sourcegraph"]);
      expect(result.skillsUsed).toEqual(["schema-watch"]);
      expect(result.apiErrors).toEqual([
        expect.objectContaining({ statusCode: 401, errorType: "authentication_error" }),
      ]);
      const toolUse = result.turns
        .flatMap((turn) => turn.blocks)
        .find((block): block is ToolUseBlock => block.type === "tool_use" && block.id === "tool_1");
      expect(toolUse?._result).toBe("file content");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records malformed JSONL lines as parse warnings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-claude-malformed-"));
    const jsonlPath = join(tempDir, "session.jsonl");
    const validLine = JSON.stringify({
      type: "user",
      sessionId: "warn-session",
      slug: "warn-session",
      cwd: "/tmp/project",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Fix malformed parser reporting" },
    });
    await writeFile(jsonlPath, `${validLine}\n{not-json\n`, "utf-8");

    try {
      const result = await parseClaudeCodeSession(jsonlPath);
      expect(result.turns).toHaveLength(1);
      expect(result.parseWarnings).toEqual([
        expect.objectContaining({
          kind: "malformed-json",
          count: 1,
          source: "claude-code JSONL",
          firstLine: 2,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Claude Code parser — images", () => {
  it("extracts user-pasted images", async () => {
    const result = await parseClaudeCodeSession(IMG_FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user");
    // User turn should have text + _user_images block
    const first = userTurns[0];
    const imgBlock = first.blocks.find((b): b is UserImagesBlock => b.type === "_user_images");
    expect(imgBlock).toBeDefined();
    expect(imgBlock!.images).toHaveLength(1);
    expect(imgBlock!.images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("extracts tool result images", async () => {
    const result = await parseClaudeCodeSession(IMG_FIXTURE);
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    const toolUse = assistantTurns[0]?.blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as ToolUseBlock)._images).toHaveLength(1);
    expect((toolUse as ToolUseBlock)._images![0]).toMatch(/^data:image\/jpeg;base64,/);
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
    expect(editScene!.type).toBe("tool-call");
    expect(editScene!.type === "tool-call" && editScene!.diff?.filePath).toBe(
      "/Users/test/project/auth.ts",
    );
    expect(editScene!.type === "tool-call" && editScene!.diff?.oldContent).toContain("return null");
    expect(editScene!.type === "tool-call" && editScene!.diff?.newContent).toContain(
      "generateToken",
    );
  });

  it("enriches Bash tool calls with command + stdout", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test/project");

    const bashScene = replay.scenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    expect(bashScene!.type).toBe("tool-call");
    expect(bashScene!.type === "tool-call" && bashScene!.bashOutput?.command).toBe("npm test");
    expect(bashScene!.type === "tool-call" && bashScene!.bashOutput?.stdout).toContain(
      "tests passed",
    );
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

  // Secret redaction is tested in transform-security.test.ts

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
