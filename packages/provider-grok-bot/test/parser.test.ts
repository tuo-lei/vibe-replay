import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyGrokBotUserWake,
  extractSendMessageText,
  extractStatusUpdateText,
  parseGrokBotLines,
  parseGrokBotSession,
  stripUserDecorators,
} from "../src/grok-bot/parser.js";
import { mapGrokBotToolArgs, mapGrokBotToolName } from "../src/grok-bot/tool-mapping.js";
import { transformToReplay } from "./helpers/transform.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = join(fixtures, "sample.jsonl");
const dmFixturePath = join(fixtures, "dm-session.jsonl");
const subagentFixturePath = join(fixtures, "subagent.jsonl");
const metaWakeFixturePath = join(fixtures, "meta-wake.jsonl");

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
    expect(
      extractSendMessageText({
        to: "dm",
        text: { content: "Visible DM reply" },
        attachments: [{ url: "https://example.invalid/card.png", title: "card" }],
      }),
    ).toBe("Visible DM reply");
    expect(extractStatusUpdateText({ update: "Scanning inbox…" })).toBe("Scanning inbox…");
  });

  it("parses the DM fixture: send_message promotion, communicate_update, and mapped tools", async () => {
    const parsed = await parseGrokBotSession(dmFixturePath);
    const userTurns = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].blocks[0]).toEqual({
      type: "text",
      text: "帮我查一下 dashboard badge copy",
    });

    const assistantText = parsed.turns
      .filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""));
    expect(assistantText).toContain("Hey — good to meet you.");
    expect(assistantText).toContain("Checking the badge copy now.");
    expect(assistantText).toContain("Badge copy looks good.");
    expect(assistantText.some((text) => text.includes("example.invalid"))).toBe(false);

    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools.map((block) => (block.type === "tool_use" ? block.name : ""))).toEqual([
      "Read",
      "TodoWrite",
      "Bash",
    ]);
    expect(tools[1]).toMatchObject({
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Confirm badge copy", status: "in_progress" },
          { content: "Reply in DM", status: "pending" },
        ],
      },
    });
    const read = tools[0];
    expect(read.type === "tool_use" && read._durationMs).toBe(3000);
    expect(read.type === "tool_use" && read._durationSource).toBe("timestamp");

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    expect(
      replay.scenes.some(
        (scene) =>
          scene.type === "tool-call" &&
          (scene.toolName === "send_message" || scene.toolName === "communicate_update"),
      ),
    ).toBe(false);
    expect(
      replay.scenes.some((scene) => scene.type === "tool-call" && scene.toolName === "Read"),
    ).toBe(true);
    expect(
      replay.scenes.some((scene) => scene.type === "tool-call" && scene.toolName === "TodoWrite"),
    ).toBe(true);
  });

  it("parses a sand-subagent fixture as its own session with promoted replies", async () => {
    const parsed = await parseGrokBotSession(subagentFixturePath, {
      provider: "grok-bot",
      sessionId: "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      slug: "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Grok Bot subagent",
      project: "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      cwd: "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      version: "1",
      timestamp: "2026-09-04T00:00:00.000Z",
      lineCount: 5,
      fileSize: 100,
      filePath: subagentFixturePath,
      filePaths: [subagentFixturePath],
      firstPrompt: "",
    });
    expect(parsed.sessionId).toBe("sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(parsed.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("send_message"))).toBe(false);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "Read", _hasResult: true });
  });

  it("classifies meta wakes and parses the meta-wake fixture", async () => {
    expect(classifyGrokBotUserWake("[routine]\nCheck unread inbox.")).toEqual({
      kind: "context-injection",
      text: "Routine: Check unread inbox.",
      label: "routine",
    });
    expect(classifyGrokBotUserWake("[inbound]\nBook a flight")).toEqual({
      kind: "prompt",
      text: "Book a flight",
      label: "inbound",
    });
    expect(classifyGrokBotUserWake('[Answering your question tbs1: "what is grok bot"]')).toEqual({
      kind: "context-injection",
      text: "Answering previous question tbs1: what is grok bot",
      label: "answering-question",
    });

    const parsed = await parseGrokBotSession(metaWakeFixturePath);
    const injections = parsed.turns.filter((turn) => turn.subtype === "context-injection");
    expect(injections.map((turn) => turn.blocks[0])).toEqual([
      { type: "text", text: "Routine: Check unread inbox and send a digest." },
      {
        type: "text",
        text: "Answering previous question tbs1: what is grok bot",
      },
    ]);
    const prompts = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(prompts.map((turn) => turn.blocks[0])).toEqual([
      { type: "text", text: "Can you book a flight to Taipei next Tuesday?" },
      { type: "text", text: "Also compare it to Claude Code." },
    ]);
    const assistantText = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""));
    expect(assistantText).toContain("Scanning inbox…");
    expect(assistantText).toContain("I can help with that.");
  });

  it("maps Sand-native tools including mcp, await, computer_use, and task", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "use the tools" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "await",
              toolCallId: "a-1",
              input: { seconds: 2 },
            },
            {
              type: "tool_use",
              name: "task",
              toolCallId: "t-1",
              input: { goal: "explore UI", context: "list badge strings", role: "explore" },
            },
            {
              type: "tool_use",
              name: "mcp",
              toolCallId: "m-1",
              input: { server: "github", toolName: "pull_request_read", pullNumber: 544 },
            },
            {
              type: "tool_use",
              name: "get_mcp_tools",
              toolCallId: "g-1",
              input: {},
            },
            {
              type: "tool_use",
              name: "computer_use",
              toolCallId: "c-1",
              input: { action: "screenshot" },
            },
            {
              type: "tool_use",
              name: "web_search",
              toolCallId: "w-1",
              input: { search_term: "vibe-replay grok bot" },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "await",
              toolCallId: "a-1",
              result: { success: { timestamp: 1788485460000 } },
            },
            {
              type: "tool_result",
              name: "task",
              toolCallId: "t-1",
              result: { success: { timestamp: 1788485465000, content: "done" } },
            },
            {
              type: "tool_result",
              name: "mcp",
              toolCallId: "m-1",
              result: { success: { timestamp: 1788485470000, content: "PR 544" } },
            },
            {
              type: "tool_result",
              name: "get_mcp_tools",
              toolCallId: "g-1",
              result: { success: { timestamp: 1788485472000, content: "github, slack" } },
            },
            {
              type: "tool_result",
              name: "computer_use",
              toolCallId: "c-1",
              result: { success: { timestamp: 1788485475000, content: "png" } },
            },
            {
              type: "tool_result",
              name: "web_search",
              toolCallId: "w-1",
              result: { success: { timestamp: 1788485480000, content: "hits" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools.map((block) => (block.type === "tool_use" ? block.name : ""))).toEqual([
      "Await",
      "Agent",
      "mcp",
      "GetMcpTools",
      "ComputerUse",
      "WebSearch",
    ]);
    expect(tools[1]).toMatchObject({
      name: "Agent",
      input: {
        description: "explore UI",
        prompt: "list badge strings",
        subagent_type: "explore",
      },
    });
    expect(tools[2]).toMatchObject({
      name: "mcp",
      input: { server: "github", toolName: "pull_request_read", tool: "pull_request_read" },
      _mcpServer: "github",
      _mcpTool: "pull_request_read",
    });
    expect(tools[5]).toMatchObject({
      name: "WebSearch",
      input: { search_term: "vibe-replay grok bot", query: "vibe-replay grok bot" },
    });
    expect(tools[2].type === "tool_use" && tools[2]._durationMs).toBe(5000);
  });
});

describe("Grok Bot tool mapping", () => {
  it("maps sand tool names and path fields onto the viewer vocabulary", () => {
    expect(mapGrokBotToolName("read")).toBe("Read");
    expect(mapGrokBotToolName("shell")).toBe("Bash");
    expect(mapGrokBotToolName("update_todos")).toBe("TodoWrite");
    expect(mapGrokBotToolName("await")).toBe("Await");
    expect(mapGrokBotToolName("computer_use")).toBe("ComputerUse");
    expect(mapGrokBotToolName("get_mcp_tools")).toBe("GetMcpTools");
    expect(mapGrokBotToolName("mcp")).toBe("mcp");
    expect(mapGrokBotToolName("pull_request_read")).toBe("pull_request_read");
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
    expect(
      mapGrokBotToolArgs("update_todos", { items: [{ content: "a", status: "pending" }] }),
    ).toMatchObject({
      todos: [{ content: "a", status: "pending" }],
    });
    expect(mapGrokBotToolArgs("web_search", { search_term: "grok" })).toMatchObject({
      query: "grok",
    });
  });
});
