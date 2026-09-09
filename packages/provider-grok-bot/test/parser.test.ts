import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyGrokBotUserWake,
  extractSendMessageText,
  extractStatusUpdateText,
  findSandSubagentId,
  parseGrokBotLines,
  parseGrokBotSession,
  rewriteGrokBotShareableText,
  scrubGrokBotMediaPayload,
  stripUserDecorators,
} from "../src/grok-bot/parser.js";
import {
  grokBotMcpAttribution,
  grokBotReplayToolName,
  mapGrokBotToolArgs,
  mapGrokBotToolName,
} from "../src/grok-bot/tool-mapping.js";
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
    expect(reply.blocks[0]).toEqual({ type: "thinking", thinking: "private scratch reasoning" });
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
    expect(types).toContain("thinking");
    expect(types).toContain("tool-call");
    expect(
      replay.scenes.some(
        (scene) => scene.type === "thinking" && scene.content === "private scratch reasoning",
      ),
    ).toBe(true);
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
    expect(assistantText).not.toContain("Checking the badge copy now.");
    expect(assistantText).toContain("Badge copy looks good.");
    expect(assistantText.some((text) => text.includes("example.invalid"))).toBe(false);

    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools.map((block) => (block.type === "tool_use" ? block.name : ""))).toEqual([
      "CommunicateUpdate",
      "Read",
      "TodoWrite",
      "Bash",
    ]);
    expect(tools[2]).toMatchObject({
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Confirm badge copy", status: "in_progress" },
          { content: "Reply in DM", status: "pending" },
        ],
      },
    });
    const read = tools[1];
    expect(read.type === "tool_use" && read._durationMs).toBe(3000);
    expect(read.type === "tool_use" && read._durationSource).toBe("timestamp");

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    expect(
      replay.scenes.some(
        (scene) => scene.type === "tool-call" && scene.toolName === "send_message",
      ),
    ).toBe(false);
    expect(
      replay.scenes.some(
        (scene) => scene.type === "tool-call" && scene.toolName === "CommunicateUpdate",
      ),
    ).toBe(true);
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
    expect(assistantText).toContain("I can help with that.");
    expect(assistantText).not.toContain("Scanning inbox…");
    const statusTools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use" && block.name === "CommunicateUpdate");
    expect(statusTools).toHaveLength(1);
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
    expect(tools[4]).toMatchObject({
      name: "WebSearch",
      input: { search_term: "vibe-replay grok bot", query: "vibe-replay grok bot" },
    });
    expect(tools[2].type === "tool_use" && tools[2]._durationMs).toBe(5000);
  });

  it("advances duration from each result when the assistant record itself is timestamped", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "run two tools" }] },
      }),
      JSON.stringify({
        role: "assistant",
        timestamp: 1788485460000,
        message: {
          content: [
            { type: "tool_use", name: "read", toolCallId: "r-1", input: { path: "/a.md" } },
            { type: "tool_use", name: "shell", toolCallId: "s-1", input: { command: "rg badge" } },
          ],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "read",
              toolCallId: "r-1",
              result: { success: { timestamp: 1788485462000, content: "ok" } },
            },
            {
              type: "tool_result",
              name: "shell",
              toolCallId: "s-1",
              result: { success: { timestamp: 1788485467000, stdout: "hit" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "Read", _durationMs: 2000 });
    expect(tools[1]).toMatchObject({ name: "Bash", _durationMs: 5000 });
  });

  it("carries a timestamped assistant clock into the next untimestamped assistant turn", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "go" }] },
      }),
      JSON.stringify({
        role: "assistant",
        timestamp: 1788485460000,
        message: { content: [{ type: "text", text: "scratch" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "read", toolCallId: "r-1", input: { path: "/a.md" } },
          ],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "read",
              toolCallId: "r-1",
              result: { success: { timestamp: 1788485464000, content: "ok" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "Read", _durationMs: 4000 });
  });

  it("keeps communicate_update as a status tool for both failure and success", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "status please" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "communicate_update",
              toolCallId: "cu-fail",
              input: { text: { content: "This ping never landed." } },
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
              name: "communicate_update",
              toolCallId: "cu-fail",
              result: { failure: { message: "delivery failed" } },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "communicate_update",
              toolCallId: "cu-ok",
              input: { update: "Still working." },
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
              name: "communicate_update",
              toolCallId: "cu-ok",
              result: { success: { timestamp: 1788485490000 } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: "CommunicateUpdate",
      _isError: true,
      _result: "delivery failed",
    });
    expect(tools[1]).toMatchObject({
      name: "CommunicateUpdate",
    });
    expect(tools[1].type === "tool_use" && tools[1]._isError).toBeUndefined();
    const texts = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""));
    expect(texts).not.toContain("Still working.");
    expect(texts).not.toContain("This ping never landed.");
  });

  it("classifies background-task, first-run, and profile-update wakes", () => {
    expect(
      classifyGrokBotUserWake("[A background task just completed]\nWrote the travel recap."),
    ).toEqual({
      kind: "context-injection",
      text: "Background task completed:\nWrote the travel recap.",
      label: "background-task",
    });
    expect(classifyGrokBotUserWake("[first run]\nbootstrap")).toEqual({ kind: "skip" });
    expect(classifyGrokBotUserWake("<<SAND_AGENT_PROFILE_UPDATE\nname: 艺术家\n>>")).toEqual({
      kind: "skip",
    });
    expect(
      classifyGrokBotUserWake("<<SAND_AGENT_PROFILE_UPDATE name=x >>\nPlease draw a cat"),
    ).toEqual({ kind: "prompt", text: "Please draw a cat" });
  });

  it("omits get_mcp_tools discovery noise and maps dynamic MCP short names", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "check the PR" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "get_mcp_tools", toolCallId: "g-1", input: {} },
            {
              type: "tool_use",
              name: "pull_request_read",
              toolCallId: "p-1",
              input: {
                serverIdentifier: "github",
                providerIdentifier: "github",
                toolName: "pull_request_read",
                args: { pullNumber: 544, method: "get" },
              },
            },
            {
              type: "tool_use",
              name: "search_analytics_query",
              toolCallId: "s-1",
              input: {
                serverIdentifier: "google-analytics",
                toolName: "search_analytics_query",
                args: { property: "properties/1" },
              },
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
              name: "get_mcp_tools",
              toolCallId: "g-1",
              result: { success: { timestamp: 1788485472000, content: "github, slack" } },
            },
            {
              type: "tool_result",
              name: "pull_request_read",
              toolCallId: "p-1",
              result: { success: { timestamp: 1788485474000, content: "PR 544" } },
            },
            {
              type: "tool_result",
              name: "search_analytics_query",
              toolCallId: "s-1",
              result: { success: { timestamp: 1788485476000, content: "rows" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools.map((block) => (block.type === "tool_use" ? block.name : ""))).toEqual([
      "mcp__github__pull_request_read",
      "mcp__google-analytics__search_analytics_query",
    ]);
    expect(tools[0]).toMatchObject({
      _mcpServer: "github",
      _mcpTool: "pull_request_read",
      input: { pullNumber: 544, method: "get", server: "github", tool: "pull_request_read" },
      _result: "PR 544",
    });
    expect(JSON.stringify(parsed.turns)).not.toContain("GetMcpTools");
  });

  it("strips generate_image and computer_use base64 while keeping file paths", () => {
    const imageData = `iVBOR${"A".repeat(120)}`;
    const screenshot = `iVBOR${"B".repeat(120)}`;
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "draw then screenshot" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "generate_image",
              toolCallId: "img-1",
              input: { prompt: "a cat" },
            },
            {
              type: "tool_use",
              name: "computer_use",
              toolCallId: "cu-1",
              input: { action: "screenshot" },
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
              name: "generate_image",
              toolCallId: "img-1",
              result: {
                success: {
                  timestamp: 1788485500000,
                  filePath: "/home/box/agent-data/assets/cat.png",
                  imageData,
                },
              },
            },
            {
              type: "tool_result",
              name: "computer_use",
              toolCallId: "cu-1",
              result: {
                success: {
                  timestamp: 1788485505000,
                  screenshotPath: "/tmp/screenshot.png",
                  screenshot,
                },
              },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({
      name: "GenerateImage",
    });
    expect(tools[0].type === "tool_use" && tools[0]._result).toContain(
      "/home/box/agent-data/assets/cat.png",
    );
    expect(tools[1]).toMatchObject({
      name: "ComputerUse",
    });
    expect(tools[1].type === "tool_use" && tools[1]._result).toContain("/tmp/screenshot.png");
    const dumped = JSON.stringify(tools);
    expect(dumped).not.toContain(imageData);
    expect(dumped).not.toContain(screenshot);
    expect(dumped).toContain("omitted");
    expect(scrubGrokBotMediaPayload({ imageData, filePath: "/x.png" })).toMatchObject({
      filePath: "/x.png",
      imageData: expect.stringContaining("omitted"),
    });
  });

  it("rewrites file:// markdown images in send_message instead of leaving a file URI", () => {
    const input = {
      text: {
        content: "See ![sketch](<file:///home/box/agent-data/attachments/cat.png>) and the rest.",
      },
    };
    expect(extractSendMessageText(input)).toBe(
      "See [image: sketch — /home/box/agent-data/attachments/cat.png] and the rest.",
    );
    expect(rewriteGrokBotShareableText("![x](file:///home/box/agent-data/assets/a.png)")).toBe(
      "[image: x — /home/box/agent-data/assets/a.png]",
    );
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "send_message", input }],
        },
      }),
    ]);
    expect(parsed.turns[0].blocks[0]).toEqual({
      type: "text",
      text: "See [image: sketch — /home/box/agent-data/attachments/cat.png] and the rest.",
    });
  });

  it("attaches a sibling sand-subagent transcript onto a parent task card", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-task-"));
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const subId = "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await mkdir(join(root, parentId), { recursive: true });
    await mkdir(join(root, subId), { recursive: true });
    await writeFile(
      join(root, parentId, `${parentId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "explore the UI" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "task",
                toolCallId: "t-1",
                input: { goal: "explore UI", context: "list badges", role: "explore" },
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
                name: "task",
                toolCallId: "t-1",
                result: {
                  success: {
                    timestamp: 1788485510000,
                    sessionId: subId,
                    content: "started",
                  },
                },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf-8",
    );
    await writeFile(
      join(root, subId, `${subId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "list badges" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "opening spec" },
              {
                type: "tool_use",
                name: "read",
                toolCallId: "r-1",
                input: { path: "/home/box/reference/app-ui.md" },
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
                name: "read",
                toolCallId: "r-1",
                result: { success: { content: "# UI" } },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf-8",
    );
    try {
      expect(findSandSubagentId({ sessionId: subId })).toBe(subId);
      const parsed = await parseGrokBotSession(join(root, parentId, `${parentId}.jsonl`));
      const agent = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agent?.type === "tool_use" && agent._subAgent).toMatchObject({
        agentId: subId,
        agentType: "Explore",
        description: "explore UI",
        prompt: "list badges",
        toolCalls: 1,
        thinkingBlocks: 1,
      });
      expect(parsed.subAgentSummary).toEqual([
        { agentId: subId, agentType: "Explore", description: "explore UI", toolCalls: 1 },
      ]);
      const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
      const scene = replay.scenes.find(
        (item) => item.type === "tool-call" && item.toolName === "Agent",
      );
      expect(scene?.type === "tool-call" && scene.subAgent?.agentId).toBe(subId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Grok Bot tool mapping", () => {
  it("maps sand tool names and path fields onto the viewer vocabulary", () => {
    expect(mapGrokBotToolName("read")).toBe("Read");
    expect(mapGrokBotToolName("shell")).toBe("Bash");
    expect(mapGrokBotToolName("update_todos")).toBe("TodoWrite");
    expect(mapGrokBotToolName("await")).toBe("Await");
    expect(mapGrokBotToolName("computer_use")).toBe("ComputerUse");
    expect(mapGrokBotToolName("generate_image")).toBe("GenerateImage");
    expect(mapGrokBotToolName("get_mcp_tools")).toBe("GetMcpTools");
    expect(mapGrokBotToolName("communicate_update")).toBe("CommunicateUpdate");
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
    expect(mapGrokBotToolArgs("web_search", { query: "", search_term: "badge" })).toMatchObject({
      query: "badge",
    });
    expect(mapGrokBotToolArgs("shell", { command: "", cmd: "rg badge" })).toMatchObject({
      command: "rg badge",
    });
    expect(
      mapGrokBotToolArgs("edit", { path: "/tmp/a.ts", old_string: "", oldText: "a", newText: "b" }),
    ).toMatchObject({
      file_path: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(
      grokBotReplayToolName("pull_request_read", {
        serverIdentifier: "github",
        toolName: "pull_request_read",
      }),
    ).toBe("mcp__github__pull_request_read");
    expect(
      mapGrokBotToolArgs("pull_request_read", {
        serverIdentifier: "github",
        toolName: "pull_request_read",
        args: { pullNumber: 544 },
      }),
    ).toMatchObject({
      server: "github",
      tool: "pull_request_read",
      pullNumber: 544,
    });
    expect(mapGrokBotToolArgs("read", { path: "/tmp/a.ts", name: "readme" })).toEqual({
      path: "/tmp/a.ts",
      name: "readme",
      file_path: "/tmp/a.ts",
    });
    expect(grokBotMcpAttribution("read", { path: "/tmp/a.ts", name: "readme" })).toBeUndefined();
    expect(grokBotMcpAttribution("mystery", { args: { name: "foo" } })).toBeUndefined();
    expect(grokBotReplayToolName("mystery", { args: { name: "foo" } })).toBe("mystery");
    expect(
      grokBotMcpAttribution("mcp", { server: "github", toolName: "pull_request_read" }),
    ).toEqual({
      server: "github",
      tool: "pull_request_read",
    });
  });
});
