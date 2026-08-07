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
});
