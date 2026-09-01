import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiSession } from "../src/pi/parser.js";
import { transformToReplay } from "./helpers/transform.js";

async function withPiFixture(lines: unknown[], fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vibe-replay-pi-parser-"));
  const path = join(dir, "2026-01-01T00-00-00-000Z_pi-session.jsonl");
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Pi parser", () => {
  it("parses Pi JSONL tree sessions and enriches tools", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "model_change",
        id: "model1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "openai",
        modelId: "gpt-5.5",
      },
      {
        type: "message",
        id: "user1",
        parentId: "model1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix auth.ts" }],
          timestamp: 1767225602000,
        },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the file." },
            { type: "text", text: "I'll inspect and patch it." },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "/Users/test/project/auth.ts" },
            },
          ],
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 5,
            cacheWrite: 7,
          },
          stopReason: "toolUse",
          timestamp: 1767225603000,
        },
      },
      {
        type: "message",
        id: "result1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "export function login() { return null; }" }],
          isError: false,
          timestamp: 1767225604000,
        },
      },
      {
        type: "message",
        id: "assistant2",
        parentId: "result1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: {
                path: "/Users/test/project/auth.ts",
                edits: [{ oldText: "return null", newText: "return token" }],
              },
            },
            {
              type: "toolCall",
              id: "call-bash",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
          ],
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 200,
            output: 30,
            cacheRead: 10,
            cacheWrite: 0,
          },
          stopReason: "toolUse",
          timestamp: 1767225605000,
        },
      },
      {
        type: "message",
        id: "result2",
        parentId: "assistant2",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced text" }],
          isError: false,
          timestamp: 1767225606000,
        },
      },
      {
        type: "message",
        id: "result3",
        parentId: "result2",
        timestamp: "2026-01-01T00:00:07.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-bash",
          toolName: "bash",
          content: [{ type: "text", text: "tests passed" }],
          isError: false,
          timestamp: 1767225607000,
        },
      },
      {
        type: "message",
        id: "assistant3",
        parentId: "result3",
        timestamp: "2026-01-01T00:00:08.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 300,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
          },
          stopReason: "stop",
          timestamp: 1767225608000,
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.sessionId).toBe("pi-session-1");
      expect(parsed.cwd).toBe("/Users/test/project");
      expect(parsed.model).toBe("gpt-5.5");
      expect(parsed.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
      expect(parsed.turns.filter((turn) => turn.role === "assistant")).toHaveLength(3);
      expect(parsed.tokenUsage).toEqual({
        inputTokens: 600,
        outputTokens: 60,
        cacheCreationTokens: 7,
        cacheReadTokens: 15,
      });
      expect(
        parsed.dataSourceInfo?.sources.map((source) => source.replaceAll("\\", "/")),
      ).toContain("~/.pi/agent/sessions");
      expect(parsed.turnStats?.map((stat) => stat.contextTokens)).toEqual([300]);

      const replay = transformToReplay(parsed, "pi", "~/project");
      expect(replay.meta.provider).toBe("pi");
      expect(replay.meta.stats.userPrompts).toBe(1);
      expect(replay.meta.stats.toolCalls).toBe(3);

      const editScene = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
      );
      expect(editScene?.type).toBe("tool-call");
      expect(editScene?.type === "tool-call" && editScene.diff?.filePath).toBe(
        "/Users/test/project/auth.ts",
      );
      expect(editScene?.type === "tool-call" && editScene.diff?.oldContent).toBe("return null");
      expect(editScene?.type === "tool-call" && editScene.diff?.newContent).toBe("return token");

      const bashScene = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Bash",
      );
      expect(bashScene?.type).toBe("tool-call");
      expect(bashScene?.type === "tool-call" && bashScene.bashOutput?.command).toBe("pnpm test");
      expect(bashScene?.type === "tool-call" && bashScene.bashOutput?.stdout).toContain(
        "tests passed",
      );
    });
  });

  it("distinguishes missing tool results from completed empty results", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-result-presence",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Check results" },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "missing", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "empty", name: "read", arguments: { path: "b.ts" } },
          ],
        },
      },
      {
        type: "message",
        id: "result1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "empty",
          content: "",
          isError: false,
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      const tools = parsed.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.type === "tool_use");
      expect(tools).toHaveLength(2);
      expect(tools.find((tool) => tool.type === "tool_use" && tool.id === "missing")).toMatchObject(
        {
          _hasResult: false,
        },
      );
      expect(tools.find((tool) => tool.type === "tool_use" && tool.id === "empty")).toMatchObject({
        _hasResult: true,
        _result: "",
      });
    });
  });

  it("summarizes unique MCP descriptors without retaining their content", async () => {
    const tool = {
      name: "sourcegraph_search",
      originalName: "search",
      description: "Private MCP tool description",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Private query description" } },
      },
    };
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-mcp-context",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Inspect MCP metadata" },
      },
      {
        type: "message",
        id: "result1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "mcp-1",
          toolName: "mcp",
          content: [{ type: "text", text: "Tool found" }],
          details: { tool },
        },
      },
      {
        type: "message",
        id: "result2",
        parentId: "result1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "mcp-2",
          toolName: "mcp",
          content: [{ type: "text", text: "Same tool found again" }],
          details: { tool },
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      const definition = {
        name: tool.name,
        originalName: tool.originalName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      expect(parsed.contextBreakdown).toEqual({
        source: "pi-mcp-results",
        scope: "observed",
        components: [
          {
            id: "mcp-tool-definitions",
            contentBytes: Buffer.byteLength(JSON.stringify(definition)),
            itemCount: 1,
            descriptionBytes: Buffer.byteLength(tool.description),
            schemaBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema)),
          },
        ],
      });
      expect(JSON.stringify(parsed.contextBreakdown)).not.toContain("Private");
    });
  });

  it("maps harness exec_command and apply_patch tools into replay-native scenes", async () => {
    const patch = `*** Begin Patch
*** Update File: src/auth.ts
@@
-return null;
+return token;
*** Add File: src/new.ts
+export const created = true;
*** End Patch`;
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-harness-tools",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Patch auth" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [
            {
              type: "toolCall",
              id: "call-exec",
              name: "exec_command",
              arguments: { cmd: "pnpm test", workdir: "/Users/test/project" },
            },
            {
              type: "toolCall",
              id: "call-patch",
              name: "apply_patch",
              arguments: { input: patch },
            },
          ],
        },
      },
      {
        type: "message",
        id: "result1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-exec",
          content: [{ type: "text", text: "tests passed" }],
        },
      },
      {
        type: "message",
        id: "result2",
        parentId: "result1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-patch",
          content: [{ type: "text", text: "Done!" }],
        },
      },
      {
        type: "message",
        id: "assistant2",
        parentId: "result2",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const replay = transformToReplay(await parsePiSession(path), "pi", "~/project");
      const bash = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Bash",
      );
      expect(bash?.type === "tool-call" && bash.bashOutput).toEqual({
        command: "pnpm test",
        stdout: "tests passed",
      });

      const edit = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
      );
      expect(edit?.type === "tool-call" && edit.input.file_paths).toEqual([
        "src/auth.ts",
        "src/new.ts",
      ]);
      expect(edit?.type === "tool-call" && edit.diff).toEqual({
        filePath: "src/auth.ts",
        oldContent: "return null;",
        newContent: "return token;",
      });
    });
  });

  it("supports Codex adapter legacy aliases without hijacking unrelated same-name tools", async () => {
    const legacyPatch = `*** Begin Patch
*** Update File: src/legacy.ts
@@
---old
+++new
*** End Patch`;
    const toolCalls = [
      {
        type: "toolCall",
        id: "legacy-exec",
        name: "exec_command",
        arguments: { command: "pwd", cwd: "/Users/test/project" },
      },
      {
        type: "toolCall",
        id: "legacy-patch",
        name: "apply_patch",
        arguments: { patchText: legacyPatch },
      },
      {
        type: "toolCall",
        id: "unrelated-patch",
        name: "apply_patch",
        arguments: { operation: "custom-extension-operation" },
      },
    ];
    const lines: unknown[] = [
      {
        type: "session",
        version: 3,
        id: "pi-legacy-tools",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Use legacy tools" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", model: "gpt-5.5", content: toolCalls },
      },
    ];
    let parentId = "assistant1";
    for (const tool of toolCalls) {
      const id = `result-${tool.id}`;
      lines.push({
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: tool.id,
          content: [{ type: "text", text: "ok" }],
        },
      });
      parentId = id;
    }
    lines.push({
      type: "message",
      id: "assistant2",
      parentId,
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "assistant", model: "gpt-5.5", content: [{ type: "text", text: "Done" }] },
    });

    await withPiFixture(lines, async (path) => {
      const replay = transformToReplay(await parsePiSession(path), "pi", "~/project");
      const bash = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Bash",
      );
      expect(bash?.type === "tool-call" && bash.input).toMatchObject({
        command: "pwd",
        workdir: "/Users/test/project",
      });

      const edit = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
      );
      expect(edit?.type === "tool-call" && edit.diff?.filePath).toBe("src/legacy.ts");
      expect(edit?.type === "tool-call" && edit.diff?.oldContent).toBe("--old");
      expect(edit?.type === "tool-call" && edit.diff?.newContent).toBe("++new");

      const unrelated = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "apply_patch",
      );
      expect(unrelated?.type === "tool-call" && unrelated.input).toEqual({
        operation: "custom-extension-operation",
      });
      expect(unrelated?.type === "tool-call" && unrelated.diff).toBeUndefined();
    });
  });

  it("keeps legacy linear v1 sessions and native Pi tools compatible", async () => {
    const lines = [
      {
        type: "session",
        version: 1,
        id: "pi-v1-session",
        timestamp: "2024-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        timestamp: "2024-01-01T00:00:01.000Z",
        message: { role: "user", content: "Fix the legacy file" },
      },
      {
        type: "message",
        timestamp: "2024-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "legacy-model",
          content: [
            {
              type: "toolCall",
              id: "legacy-bash",
              name: "bash",
              arguments: { command: "test -f legacy.ts" },
            },
            {
              type: "toolCall",
              id: "legacy-edit",
              name: "edit",
              arguments: {
                path: "legacy.ts",
                oldText: "old",
                newText: "new",
              },
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2024-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "legacy-bash",
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        type: "message",
        timestamp: "2024-01-01T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "legacy-edit",
          content: [{ type: "text", text: "edited" }],
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      const replay = transformToReplay(parsed, "pi", "~/project");
      expect(parsed.sessionId).toBe("pi-v1-session");
      expect(replay.meta.stats.userPrompts).toBe(1);
      expect(replay.meta.stats.toolCalls).toBe(2);
      expect(
        replay.scenes.some((scene) => scene.type === "tool-call" && scene.toolName === "Bash"),
      ).toBe(true);
      expect(
        replay.scenes.some((scene) => scene.type === "tool-call" && scene.toolName === "Edit"),
      ).toBe(true);
    });
  });

  it("uses the active leaf branch and omits abandoned branches", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-branch-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "root-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Root prompt" }] },
      },
      {
        type: "message",
        id: "main-answer",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Old branch answer" }],
          model: "gpt-5.5",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "message",
        id: "branch-user",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "New branch prompt" }] },
      },
      {
        type: "session_info",
        parentId: "branch-user",
        timestamp: "2026-01-01T00:00:03.500Z",
        name: "ID-less branch title",
      },
      {
        type: "message",
        id: "branch-answer",
        parentId: "branch-user",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "New branch answer" }],
          model: "gpt-5.5",
          usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      const text = parsed.turns
        .flatMap((turn) => turn.blocks)
        .map((block) => {
          if (block.type === "text") return block.text;
          return "";
        })
        .join("\n");
      expect(text).toContain("Root prompt");
      expect(text).toContain("New branch prompt");
      expect(text).toContain("New branch answer");
      expect(text).not.toContain("Old branch answer");
      expect(parsed.title).toBe("ID-less branch title");
      expect(parsed.dataSourceInfo?.notes).toEqual(["1 off-branch Pi entries were omitted."]);
    });
  });

  it("marks harness tool results failed when details report a non-zero exit code", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-exit-code",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Run the suite" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [
            {
              type: "toolCall",
              id: "call-fail",
              name: "exec_command",
              arguments: { cmd: "pnpm test" },
            },
            {
              type: "toolCall",
              id: "call-pass",
              name: "exec_command",
              arguments: { cmd: "pnpm lint" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "result-fail",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-fail",
          isError: false,
          details: { exit_code: 1 },
          content: [{ type: "text", text: "1 test failed" }],
        },
      },
      {
        type: "message",
        id: "result-pass",
        parentId: "result-fail",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-pass",
          isError: false,
          details: { exit_code: 0 },
          content: [{ type: "text", text: "lint clean" }],
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      const blocks = parsed.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.type === "tool_use");
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type === "tool_use" && blocks[0]._isError).toBe(true);
      expect(blocks[1].type === "tool_use" && blocks[1]._isError).toBeUndefined();
    });
  });

  it("counts compaction summary usage without changing the preceding turn stats", async () => {
    const buildLines = (compaction: Record<string, unknown>) => [
      {
        type: "session",
        version: 3,
        id: "pi-compaction-usage",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Long task" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Working" }],
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 5 },
        },
      },
      { type: "compaction", id: "compact1", parentId: "assistant1", ...compaction },
    ];

    await withPiFixture(
      buildLines({
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        tokensBefore: 90_000,
        usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
      async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.tokenUsage).toEqual({
          inputTokens: 140,
          outputTokens: 30,
          cacheCreationTokens: 5,
          cacheReadTokens: 5,
        });
        expect(parsed.tokenUsageByModel?.["gpt-5.5"]).toEqual({
          inputTokens: 140,
          outputTokens: 30,
          cacheCreationTokens: 5,
          cacheReadTokens: 5,
        });
        expect(parsed.compactions?.[0]?.preTokens).toBe(90_000);
        expect(parsed.turnStats).toEqual([
          {
            turnIndex: 0,
            segmentIndex: 0,
            model: "gpt-5.5",
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheCreationTokens: 5,
              cacheReadTokens: 5,
            },
            contextTokens: 110,
          },
        ]);
      },
    );

    await withPiFixture(
      buildLines({
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        tokensBefore: 90_000,
      }),
      async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.tokenUsage).toEqual({
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 5,
          cacheReadTokens: 5,
        });
      },
    );

    await withPiFixture(
      [
        ...buildLines({
          timestamp: "2026-01-01T00:00:03.000Z",
          summary: "Earlier work condensed.",
          tokensBefore: 90_000,
        }),
        {
          type: "message",
          id: "assistant2",
          parentId: "compact1",
          timestamp: "2026-01-01T00:00:04.000Z",
          message: {
            role: "assistant",
            model: "gpt-5.5",
            content: [{ type: "text", text: "Continuing" }],
            usage: { input: 200, output: 30, cacheRead: 80, cacheWrite: 10 },
          },
        },
      ],
      async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.turnStats).toEqual([
          {
            turnIndex: 0,
            segmentIndex: 0,
            model: "gpt-5.5",
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheCreationTokens: 5,
              cacheReadTokens: 5,
            },
            contextTokens: 110,
          },
          {
            turnIndex: 0,
            segmentIndex: 1,
            model: "gpt-5.5",
            tokenUsage: {
              inputTokens: 200,
              outputTokens: 30,
              cacheCreationTokens: 10,
              cacheReadTokens: 80,
            },
            contextTokens: 290,
          },
        ]);
      },
    );
  });

  it("separates inferred automatic compactions, explicit compaction failures, and API errors", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-compaction-diagnostics",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Do a long task" }] },
      },
      {
        type: "message",
        id: "assistant-length",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "The response was truncated." }],
          stopReason: "length",
        },
      },
      {
        type: "compaction",
        id: "compact1",
        parentId: "assistant-length",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        tokensBefore: 90_000,
      },
      {
        type: "message",
        id: "assistant-api-error",
        parentId: "compact1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          stopReason: "error",
          errorMessage: "OpenAI API error (500): 500 status code (no body)",
        },
      },
      {
        type: "message",
        id: "assistant-compaction-error",
        parentId: "assistant-api-error",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          stopReason: "error",
          errorMessage: "Auto-compaction failed: Connection error.",
        },
      },
      {
        type: "message",
        id: "assistant-manual-compaction-error",
        parentId: "assistant-compaction-error",
        timestamp: "2026-01-01T00:00:06.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          stopReason: "error",
          errorMessage: "Manual compaction failed: user cancelled.",
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.diagnostics).toMatchObject([
        {
          kind: "compaction",
          outcome: "succeeded",
          trigger: "automatic-context",
          confidence: "inferred",
          preTokens: 90_000,
        },
        {
          kind: "assistant-api-error",
          outcome: "failed",
          statusCode: 500,
          errorType: "server_error",
        },
        {
          kind: "compaction",
          outcome: "failed",
          trigger: "automatic-context",
          errorType: "connection_error",
        },
        {
          kind: "compaction",
          outcome: "failed",
          trigger: "manual",
          errorType: "aborted",
        },
      ]);
      expect(parsed.diagnostics?.filter((event) => event.kind === "compaction")).toHaveLength(3);
      expect(
        parsed.diagnostics?.filter((event) => event.kind === "assistant-api-error"),
      ).toHaveLength(1);
      expect(JSON.stringify(parsed.diagnostics)).not.toContain("OpenAI API error");
      expect(parsed.diagnosticNotes).toContain(
        "Pi JSONL persists completed compaction entries, but not compaction_start/compaction_end or session_compact_failed lifecycle events.",
      );
    });
  });

  it("does not invent a compaction trigger when persisted evidence is insufficient", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-compaction-unknown-trigger",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Compact this session" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "unknown-model",
          content: [{ type: "text", text: "The work is complete." }],
          stopReason: "stop",
        },
      },
      {
        type: "compaction",
        id: "compact1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        tokensBefore: 1_000,
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.diagnostics).toMatchObject([
        {
          kind: "compaction",
          outcome: "succeeded",
          trigger: "unknown",
          confidence: "unknown",
        },
      ]);
    });
  });

  it("preserves explicit compaction details and retry metadata when persisted", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-compaction-explicit-details",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "model_change",
        id: "model1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "openai",
        modelId: "gpt-5.5",
      },
      {
        type: "message",
        id: "user1",
        parentId: "model1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "Compact this session" }] },
      },
      {
        type: "compaction",
        id: "compact1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        tokensBefore: 1_000,
        details: { reason: "manual" },
      },
      {
        type: "message",
        id: "assistant-error",
        parentId: "compact1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          stopReason: "error",
          retryAttempt: 2,
          errorMessage: "OpenAI API error (500): 500 status code (no body)",
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.diagnostics).toMatchObject([
        {
          kind: "compaction",
          trigger: "manual",
          confidence: "exact",
          provider: "openai",
        },
        {
          kind: "assistant-api-error",
          retryAttempt: 2,
          provider: "openai",
        },
      ]);
      expect(parsed.apiErrors).toMatchObject([{ statusCode: 500, retryAttempt: 2 }]);
    });
  });

  it("reports the last selected model so discovery and replay agree", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-model-switch",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "model_change",
        id: "model1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        modelId: "first-model",
      },
      {
        type: "message",
        id: "user1",
        parentId: "model1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "Switch models" }] },
      },
      {
        type: "model_change",
        id: "model2",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:03.000Z",
        modelId: "second-model",
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "model2",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.model).toBe("second-model");
      expect(parsed.tokenUsageByModel?.["second-model"]).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    });
  });

  it("renders every replacement of a multi-part native edit", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-multi-edit",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Rename helpers" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: {
                path: "/Users/test/project/util.ts",
                edits: [
                  { oldText: "const a = 1", newText: "const alpha = 1" },
                  { oldText: "const b = 2", newText: "const beta = 2" },
                  { oldText: "const c = 3", newText: "const gamma = 3" },
                ],
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "result1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-edit",
          content: [{ type: "text", text: "edited" }],
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const replay = transformToReplay(await parsePiSession(path), "pi", "~/project");
      const edit = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
      );
      expect(edit?.type).toBe("tool-call");
      expect(edit?.type === "tool-call" && edit.diff?.filePath).toBe("/Users/test/project/util.ts");
      expect(edit?.type === "tool-call" && edit.diff?.oldContent).toBe(
        "const a = 1\n\nconst b = 2\n\nconst c = 3",
      );
      expect(edit?.type === "tool-call" && edit.diff?.newContent).toBe(
        "const alpha = 1\n\nconst beta = 2\n\nconst gamma = 3",
      );
    });
  });

  it("ignores incomplete native edit replacement pairs", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-incomplete-edit",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix the file" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-edit",
              name: "edit",
              arguments: {
                path: "/Users/test/project/util.ts",
                edits: [
                  { oldText: "const old = 1", newText: "const next = 1" },
                  { oldText: "orphaned old text" },
                  { newText: "orphaned new text" },
                ],
              },
            },
          ],
        },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const replay = transformToReplay(await parsePiSession(path), "pi", "~/project");
      const edit = replay.scenes.find(
        (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
      );
      expect(edit?.type).toBe("tool-call");
      expect(edit?.type === "tool-call" && edit.diff?.oldContent).toBe("const old = 1");
      expect(edit?.type === "tool-call" && edit.diff?.newContent).toBe("const next = 1");
    });
  });

  it("ignores summary usage entries with invalid token values", async () => {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-invalid-summary-usage",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Summarize" }] },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Working" }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "compaction",
        id: "compact1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier work condensed.",
        usage: { input: -1, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    ];

    await withPiFixture(lines, async (path) => {
      const parsed = await parsePiSession(path);
      expect(parsed.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    });
  });

  it("ignores all-zero assistant usage snapshots", async () => {
    await withPiFixture(
      [
        {
          type: "session",
          version: 3,
          id: "pi-zero-usage",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/Users/test/project",
        },
        {
          type: "message",
          id: "user1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "Inspect usage" }] },
        },
        {
          type: "message",
          id: "assistant1",
          parentId: "user1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            model: "gpt-5.5",
            content: [{ type: "text", text: "Done" }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
      async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.tokenUsage).toBeUndefined();
        expect(parsed.tokenUsageByModel).toBeUndefined();
        expect(parsed.turnStats?.[0]?.tokenUsage).toBeUndefined();
      },
    );
  });

  it("keeps usage from assistant records without visible content", async () => {
    await withPiFixture(
      [
        {
          type: "session",
          version: 3,
          id: "pi-usage-only",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/Users/test/project",
        },
        {
          type: "message",
          id: "user1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "Inspect usage" }] },
        },
        {
          type: "message",
          id: "assistant1",
          parentId: "user1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            model: "gpt-5.5",
            content: [],
            stopReason: "length",
            usage: { input: 96, output: 512, cacheRead: 755, cacheWrite: 854 },
          },
        },
      ],
      async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.tokenUsage).toEqual({
          inputTokens: 96,
          outputTokens: 512,
          cacheCreationTokens: 854,
          cacheReadTokens: 755,
        });
        expect(parsed.turns).toHaveLength(1);
        expect(parsed.turnStats).toBeUndefined();
        expect(parsed.dataSourceInfo?.notes).toContain(
          "1 assistant records had usage but no visible content; their tokens are included in session totals but omitted from replay scenes.",
        );

        const replay = transformToReplay(parsed, "pi", "~/project");
        expect(replay.scenes).toHaveLength(1);
        expect(replay.meta.stats.tokenUsage).toEqual(parsed.tokenUsage);
      },
    );
  });

  it.each([
    { pairs: 15, expectedScenes: 30 },
    { pairs: 250, expectedScenes: 500 },
  ])(
    "parses generated Pi sessions with $expectedScenes scenes",
    async ({ pairs, expectedScenes }) => {
      const lines: Record<string, unknown>[] = [
        {
          type: "session",
          version: 3,
          id: `pi-generated-${pairs}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/Users/test/project",
        },
      ];
      let parentId: string | null = null;
      for (let index = 0; index < pairs; index++) {
        const userId = `user-${index}`;
        const assistantId = `assistant-${index}`;
        const timestamp = new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
        ).toISOString();
        lines.push({
          type: "message",
          id: userId,
          parentId,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: `Prompt ${index}` }] },
        });
        lines.push({
          type: "message",
          id: assistantId,
          parentId: userId,
          timestamp: new Date(Date.parse(timestamp) + 500).toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: `Response ${index}` }] },
        });
        parentId = assistantId;
      }

      await withPiFixture(lines, async (path) => {
        const replay = transformToReplay(await parsePiSession(path), "pi", "~/project");
        expect(replay.scenes).toHaveLength(expectedScenes);
      });
    },
  );

  it.each([10, 40])(
    "caps a %i-minute idle gap consistently with other providers",
    async (gapMinutes) => {
      const start = "2026-01-01T00:00:00.000Z";
      const end = new Date(Date.parse(start) + gapMinutes * 60_000).toISOString();
      const lines = [
        {
          type: "session",
          version: 3,
          id: `pi-duration-${gapMinutes}`,
          timestamp: start,
          cwd: "/Users/test/project",
        },
        {
          type: "message",
          id: "user1",
          parentId: null,
          timestamp: start,
          message: { role: "user", content: [{ type: "text", text: "Start work" }] },
        },
        {
          type: "message",
          id: "assistant1",
          parentId: "user1",
          timestamp: end,
          message: {
            role: "assistant",
            model: "gpt-5.5",
            content: [{ type: "text", text: "Done" }],
          },
        },
      ];

      await withPiFixture(lines, async (path) => {
        const parsed = await parsePiSession(path);
        expect(parsed.totalDurationMs).toBe(5 * 60_000);
      });
    },
  );
});
