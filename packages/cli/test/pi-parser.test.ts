import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiSession } from "../src/providers/pi/parser.js";
import { transformToReplay } from "../src/transform.js";

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
