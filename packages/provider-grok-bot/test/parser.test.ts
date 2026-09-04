import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractSendMessageText,
  parseGrokBotLines,
  parseGrokBotSession,
  stripUserDecorators,
} from "../src/grok-bot/parser.js";
import { mapGrokBotToolArgs, mapGrokBotToolName } from "../src/grok-bot/tool-mapping.js";
import { transformToReplay } from "./helpers/transform.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.jsonl");

async function withFixture(lines: unknown[], fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-parser-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Grok Bot parser", () => {
  it("parses the real-shape sample into user, visible reply, scratch, and tool turns", async () => {
    const parsed = await parseGrokBotSession(fixturePath);
    const userTurns = parsed.turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].blocks).toEqual([{ type: "text", text: "你给我介绍grok bot" }]);

    const assistantTurns = parsed.turns.filter((turn) => turn.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThanOrEqual(3);

    const greeting = assistantTurns[0];
    expect(greeting.blocks).toEqual([{ type: "text", text: "Hey — good to meet you." }]);
    expect(greeting.timestamp).toBe(new Date(1788485400095).toISOString());

    const reply = assistantTurns[1];
    expect(reply.blocks[0]).toEqual({ type: "text", text: "private scratch reasoning" });
    expect(reply.blocks[1]).toEqual({ type: "text", text: "先给你讲清楚…" });

    const readTurn = assistantTurns[2];
    expect(readTurn.blocks).toHaveLength(1);
    expect(readTurn.blocks[0]).toMatchObject({
      type: "tool_use",
      name: "Read",
      input: { path: "/home/box/reference/app-ui.md", file_path: "/home/box/reference/app-ui.md" },
      _hasResult: true,
      _result: "# The Grok Bot app UI…",
    });

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    expect(replay.meta.provider).toBe("grok-bot");
    const types = replay.scenes.map((scene) => scene.type);
    expect(types).toContain("user-prompt");
    expect(types).toContain("text-response");
    expect(types).toContain("tool-call");
    const userScene = replay.scenes.find((scene) => scene.type === "user-prompt");
    expect(userScene?.type === "user-prompt" && userScene.content).toBe("你给我介绍grok bot");
    const toolScene = replay.scenes.find((scene) => scene.type === "tool-call");
    expect(toolScene?.type === "tool-call" && toolScene.toolName).toBe("Read");
    expect(toolScene?.type === "tool-call" && toolScene.result).toContain("Grok Bot app UI");
    expect(
      replay.scenes.some(
        (scene) => scene.type === "tool-call" && scene.toolName === "send_message",
      ),
    ).toBe(false);
  });

  it("skips hidden prompts and strips [tNu] prefixes", () => {
    expect(stripUserDecorators("[t0u]\nhello")).toBe("hello");
    expect(stripUserDecorators("[t3u] later")).toBe("later");
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "[SAND_HIDDEN_PROMPT] secret" }] },
      }),
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "[t3u]\nvisible prompt" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "send_message", input: { text: { content: "ok" } } }],
        },
      }),
    ]);
    expect(parsed.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(parsed.turns[0].blocks[0]).toEqual({ type: "text", text: "visible prompt" });
  });

  it("promotes widget-bearing send_message content and pairs toolCallId results", async () => {
    await withFixture(
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "show widgets" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "send_message",
                toolCallId: "sm-1",
                input: {
                  text: {
                    content: "Visible widget reply",
                    widgets: [{ type: "button", label: "Continue" }],
                  },
                },
              },
              {
                type: "tool_use",
                name: "write",
                toolCallId: "w-1",
                input: { path: "/home/box/out.md", content: "# hi" },
              },
            ],
          },
        },
        {
          role: "tool",
          message: {
            content: [
              {
                type: "tool_result",
                name: "send_message",
                toolCallId: "sm-1",
                result: { success: { messageId: "t1s0" } },
              },
              {
                type: "tool_result",
                name: "write",
                toolCallId: "w-1",
                result: { success: { content: "wrote out.md" } },
              },
            ],
          },
        },
      ],
      async (path) => {
        const parsed = await parseGrokBotSession(path);
        const assistant = parsed.turns.find((turn) => turn.role === "assistant");
        expect(assistant?.blocks[0]).toEqual({ type: "text", text: "Visible widget reply" });
        expect(assistant?.blocks[1]).toMatchObject({
          type: "tool_use",
          name: "Write",
          id: "w-1",
          input: { path: "/home/box/out.md", file_path: "/home/box/out.md", content: "# hi" },
          _result: "wrote out.md",
        });
      },
    );
  });

  it("marks failure and rejected tool results as errors", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "run it" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "shell", input: { command: "false" } }],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "shell",
              result: { failure: { message: "exit 1" } },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "read", input: { path: "/nope" } }],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "read",
              result: { rejected: { reason: "permission denied" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "Bash", _isError: true, _result: "exit 1" });
    expect(tools[1]).toMatchObject({
      name: "Read",
      _isError: true,
      _result: expect.stringContaining("permission denied"),
    });
  });

  it("records a parse warning for malformed JSONL and keeps later turns", () => {
    const parsed = parseGrokBotLines([
      "{not-json}",
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "still here" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "send_message", input: { text: { content: "ok" } } }],
        },
      }),
    ]);
    expect(parsed.parseWarnings?.[0]).toMatchObject({
      kind: "malformed-json",
      source: "grok-bot JSONL",
      firstLine: 1,
    });
    expect(parsed.turns[0].blocks[0]).toEqual({ type: "text", text: "still here" });
  });

  it("extracts send_message text from nested content and widget-only payloads", () => {
    expect(extractSendMessageText({ text: { content: "Hey — good to meet you." } })).toBe(
      "Hey — good to meet you.",
    );
    expect(extractSendMessageText({ text: "plain" })).toBe("plain");
    expect(extractSendMessageText({ text: { widgets: [{ label: "Continue" }] } })).toBe("Continue");
  });
});

describe("Grok Bot tool mapping", () => {
  it("maps sand tool names and path fields onto the viewer vocabulary", () => {
    expect(mapGrokBotToolName("read")).toBe("Read");
    expect(mapGrokBotToolName("shell")).toBe("Bash");
    expect(mapGrokBotToolArgs("read", { path: "/tmp/a.ts" })).toMatchObject({
      path: "/tmp/a.ts",
      file_path: "/tmp/a.ts",
    });
    expect(
      mapGrokBotToolArgs("edit", { path: "/tmp/a.ts", oldText: "a", newText: "b" }),
    ).toMatchObject({
      file_path: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
    });
  });
});
