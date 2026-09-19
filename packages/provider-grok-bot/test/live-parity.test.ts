import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGrokBotSessions } from "../src/grok-bot/discover.js";
import {
  countGrokBotDiscoveryStats,
  extractSendMessageText,
  extractStatusUpdateText,
  parseGrokBotGroupWake,
  parseGrokBotLines,
  parseGrokBotSession,
  scrubGrokBotMediaPayload,
  stripGrokBotHiddenPayload,
} from "../src/grok-bot/parser.js";
import {
  flattenGrokBotStatusText,
  grokBotReplayToolName,
  mapGrokBotToolArgs,
} from "../src/grok-bot/tool-mapping.js";
import { transformToReplay } from "./helpers/transform.js";

const HUGE_SCREENSHOT = `iVBOR${"A".repeat(220)}`;
const HUGE_IMAGE = `iVBOR${"B".repeat(220)}`;

const LIVE_GROUP_WAKE = `[Group chat: "Tuo Lei, Vibe Replay GTM, Vibe Replay Eng" - with Vibe Replay Eng]
Participants: Vibe Replay Eng (The user primarily works in Engineering — tailor suggestions and work to that area. The user works with GitHub, Cursor, Workspace every day — start with those tools when suggesting connectors or taking on work.)
New messages in the room (oldest first):
User: eng那边刚做了vibe replay 支持grok bot，gtm你去准备一个blog
Vibe Replay Eng: @Vibe Replay GTM 刚合的是 #544

It's your turn, Vibe Replay GTM. Reply in character with SendToUser if you have something worth adding; if you don't, end your turn without sending anything.

[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:eyJuYW1lIjoiVmliZSBSZXBsYXkgR1RNIn0=>>`;

describe("Grok Bot live-session parity", () => {
  it("promotes communicate_update.currentStep (plain and JSON-in-string) onto update", () => {
    expect(mapGrokBotToolArgs("communicate_update", { currentStep: "Checking inbox…" })).toEqual(
      expect.objectContaining({ update: "Checking inbox…", currentStep: "Checking inbox…" }),
    );
    expect(
      mapGrokBotToolArgs("communicate_update", {
        currentStep: JSON.stringify({
          __sand_tool__: true,
          tool: "update_state",
          detail: "profile",
          result: "Updated your description.",
        }),
      }).update,
    ).toBe("Updated your description.");
    expect(
      flattenGrokBotStatusText(
        JSON.stringify({
          text: "Navigated to https://analytics.google.com/",
          imageKey: "shot-1788503824553-oenedpx3",
        }),
      ),
    ).toBe("Navigated to https://analytics.google.com/");
    expect(extractStatusUpdateText({ currentStep: "Remembered in shared user memory." })).toBe(
      "Remembered in shared user memory.",
    );

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
              input: {
                currentStep: JSON.stringify({
                  __sand_tool__: true,
                  result: "No MCP servers are installed.",
                }),
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
              name: "communicate_update",
              result: { success: { currentStep: "No MCP servers are installed." } },
            },
          ],
        },
      }),
    ]);
    const tool = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      name: "CommunicateUpdate",
      input: { update: "No MCP servers are installed." },
      _result: "No MCP servers are installed.",
    });
    expect(tool?.type).toBe("tool_use");
    expect(tool?.type === "tool_use" && tool.input.update).toBe("No MCP servers are installed.");

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    const scene = replay.scenes.find(
      (item) => item.type === "tool-call" && item.toolName === "CommunicateUpdate",
    );
    expect(scene?.type === "tool-call" && scene.input.update).toBe("No MCP servers are installed.");
  });

  it("does not crash or invent text for an empty send_message", () => {
    expect(extractSendMessageText({})).toBe("");
    expect(extractSendMessageText({ text: { content: "" } })).toBe("");
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "send_message", input: {} }] },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "send_message",
              result: {
                error: {
                  error: "Invalid arguments:\ncontent: content is only valid with type:text",
                },
              },
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
              name: "send_message",
              input: { text: { content: "What should I help you make?" } },
            },
          ],
        },
      }),
    ]);
    const texts = parsed.turns
      .filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""));
    expect(texts).toEqual(["What should I help you make?"]);
    expect(texts.every((text) => text.trim().length > 0)).toBe(true);
    expect(
      parsed.turns.some((turn) =>
        turn.blocks.some((block) => block.type === "tool_use" && block.name === "send_message"),
      ),
    ).toBe(false);
  });

  it("maps live MCP short-name tools with args and arguments payloads", () => {
    expect(
      grokBotReplayToolName("get_me", {
        name: "user-Github-get_me",
        providerIdentifier: "user-Github",
        toolName: "get_me",
        skipApproval: true,
        serverIdentifier: "user-Github",
      }),
    ).toBe("mcp__user-Github__get_me");

    const fromArgs = mapGrokBotToolArgs("list_pull_requests", {
      name: "user-Github-list_pull_requests",
      args: { owner: "tuo-lei", repo: "vibe-replay", state: "open", perPage: 5 },
      providerIdentifier: "user-Github",
      toolName: "list_pull_requests",
      skipApproval: true,
      serverIdentifier: "user-Github",
      toolCallId: "call-7b481d12-55fb-4a52-81ae-aa8dece9013c-34",
    });
    expect(fromArgs).toMatchObject({
      owner: "tuo-lei",
      repo: "vibe-replay",
      state: "open",
      perPage: 5,
      server: "user-Github",
      tool: "list_pull_requests",
    });
    expect(fromArgs.serverIdentifier).toBeUndefined();
    expect(fromArgs.name).toBeUndefined();
    expect(fromArgs.skipApproval).toBeUndefined();

    const fromArguments = mapGrokBotToolArgs("search_code", {
      serverIdentifier: "github",
      providerIdentifier: "github",
      toolName: "search_code",
      arguments: { q: "mapGrokBotToolArgs" },
    });
    expect(fromArguments).toMatchObject({
      q: "mapGrokBotToolArgs",
      server: "github",
      tool: "search_code",
    });
    expect(
      grokBotReplayToolName("search_code", {
        serverIdentifier: "github",
        toolName: "search_code",
        arguments: { q: "mapGrokBotToolArgs" },
      }),
    ).toBe("mcp__github__search_code");
    expect(grokBotReplayToolName("mystery", { arguments: { toolName: "foo" } })).toBe("mystery");

    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "check the PR" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "list_pull_requests",
              input: {
                name: "user-Github-list_pull_requests",
                args: { owner: "tuo-lei", repo: "vibe-replay", state: "open" },
                providerIdentifier: "user-Github",
                toolName: "list_pull_requests",
                skipApproval: true,
                serverIdentifier: "user-Github",
              },
            },
            {
              type: "tool_use",
              name: "get_file_contents",
              input: {
                serverIdentifier: "user-Github",
                providerIdentifier: "user-Github",
                toolName: "get_file_contents",
                arguments: { owner: "tuo-lei", repo: "vibe-replay", path: "README.md" },
              },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools.map((block) => (block.type === "tool_use" ? block.name : ""))).toEqual([
      "mcp__user-Github__list_pull_requests",
      "mcp__user-Github__get_file_contents",
    ]);
    expect(tools[0]).toMatchObject({
      _mcpServer: "user-Github",
      _mcpTool: "list_pull_requests",
      input: { owner: "tuo-lei", repo: "vibe-replay", state: "open" },
    });
    expect(tools[1]).toMatchObject({
      _mcpServer: "user-Github",
      _mcpTool: "get_file_contents",
      input: { path: "README.md" },
    });
  });

  it("scrubs computer_use screenshot without a path and generate_image imageData", () => {
    expect(
      mapGrokBotToolArgs("computer_use", {
        actions: [{ type: "click", ref: "e12" }, { type: "screenshot" }],
      }).description,
    ).toBe("click, screenshot");
    expect(
      mapGrokBotToolArgs("generate_image", {
        description: "3D claymation figurine of a young East Asian boy",
        filePath: "leon-clay-figurine.png",
        aspectRatio: "3:4",
      }),
    ).toMatchObject({
      prompt: "3D claymation figurine of a young East Asian boy",
      file_path: "leon-clay-figurine.png",
    });

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
              name: "computer_use",
              toolCallId: "cu-1",
              input: {
                actions: [
                  { type: "navigate", url: "https://analytics.google.com/" },
                  { type: "screenshot" },
                ],
              },
            },
            {
              type: "tool_use",
              name: "generate_image",
              toolCallId: "img-1",
              input: {
                description: "3D claymation figurine of a young East Asian boy",
                filePath: "leon-clay-figurine.png",
                referenceImagePaths: ["/home/box/agent-data/agents/7fbf97e7/attachments/ref.png"],
                aspectRatio: "3:4",
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
              name: "computer_use",
              toolCallId: "cu-1",
              result: {
                success: { actionCount: 2, durationMs: 1400, screenshot: HUGE_SCREENSHOT },
              },
            },
            {
              type: "tool_result",
              name: "generate_image",
              toolCallId: "img-1",
              result: {
                success: {
                  filePath:
                    "/home/box/sand-data/agents/7fbf97e7-9806-4a22-8aaf-786cbef92ab9/assets/88842707d193.png",
                  imageData: HUGE_IMAGE,
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
      name: "ComputerUse",
      input: { description: "navigate, screenshot" },
    });
    expect(tools[0].type === "tool_use" && tools[0]._result).toContain("2 actions");
    expect(tools[0].type === "tool_use" && tools[0]._result).toContain("omitted");
    expect(tools[1]).toMatchObject({
      name: "GenerateImage",
      input: { file_path: "leon-clay-figurine.png" },
    });
    expect(tools[1].type === "tool_use" && tools[1]._result).toContain("88842707d193.png");
    expect(tools[1].type === "tool_use" && tools[1]._result).toContain("omitted");
    const dumped = JSON.stringify(parsed.turns);
    expect(dumped).not.toContain(HUGE_SCREENSHOT);
    expect(dumped).not.toContain(HUGE_IMAGE);
    expect(scrubGrokBotMediaPayload({ screenshot: HUGE_SCREENSHOT })).toMatchObject({
      screenshot: expect.stringContaining("omitted"),
    });

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    expect(JSON.stringify(replay.scenes)).not.toContain(HUGE_SCREENSHOT);
    expect(JSON.stringify(replay.scenes)).not.toContain(HUGE_IMAGE);
  });

  it("splits a live Eng↔GTM group wake and ignores trailing hidden prompts", () => {
    expect(stripGrokBotHiddenPayload(LIVE_GROUP_WAKE)).toContain("[Group chat:");
    expect(stripGrokBotHiddenPayload(LIVE_GROUP_WAKE)).not.toContain("[SAND_HIDDEN_PROMPT]");
    const wake = parseGrokBotGroupWake(stripGrokBotHiddenPayload(LIVE_GROUP_WAKE));
    expect(wake).toMatchObject({
      groupTitle: "Tuo Lei, Vibe Replay GTM, Vibe Replay Eng",
      withParticipants: ["Vibe Replay Eng"],
      turnRecipient: "Vibe Replay GTM",
      noNewMessages: false,
    });
    expect(wake?.participants[0]?.name).toBe("Vibe Replay Eng");
    expect(wake?.messages.map((msg) => msg.speaker)).toEqual(["User", "Vibe Replay Eng"]);
    expect(wake?.messages.some((msg) => /your turn/i.test(msg.text))).toBe(false);
    expect(wake?.messages.some((msg) => /SAND_HIDDEN_PROMPT/i.test(msg.text))).toBe(false);

    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: LIVE_GROUP_WAKE }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "send_message",
              input: { text: { content: "收到，我去写 blog。" } },
            },
          ],
        },
      }),
    ]);
    expect(parsed.title).toBe("Group: Tuo Lei, Vibe Replay GTM, Vibe Replay Eng");
    const users = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(users).toHaveLength(1);
    expect(users[0].blocks[0]).toEqual({
      type: "text",
      text: "eng那边刚做了vibe replay 支持grok bot，gtm你去准备一个blog",
    });
    expect(JSON.stringify(parsed.turns)).not.toContain("[SAND_HIDDEN_PROMPT]");
    expect(JSON.stringify(parsed.turns)).not.toContain("It's your turn");

    const stats = countGrokBotDiscoveryStats(
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: LIVE_GROUP_WAKE }] },
      })}\n`,
    );
    expect(stats).toMatchObject({
      groupTitle: "Tuo Lei, Vibe Replay GTM, Vibe Replay Eng",
      isGroupChat: true,
      promptCount: 1,
      firstPrompt: "eng那边刚做了vibe replay 支持grok bot，gtm你去准备一个blog",
    });
  });

  it("attaches a sand-subagent from nested success.agentId, not the input run uuid", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-live-task-"));
    const parentId = "33c0f7c3-3212-48eb-bd1b-1ce8c0ea0f88";
    const runId = "f7ec876f-3b29-4fa0-963e-d5587044db7e";
    const subId = "sand-subagent-f7375718-c429-478f-8b6c-1de4f1c28f56";
    await mkdir(join(root, parentId), { recursive: true });
    await mkdir(join(root, subId), { recursive: true });
    await writeFile(
      join(root, parentId, `${parentId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Map Grok Bot sessions" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "task",
                input: {
                  description: "Map Grok Bot sessions",
                  prompt: "Research where Grok Bot stores conversation sessions.",
                  subagentType: { custom: { name: "executor" } },
                  model: "sand-default",
                  agentId: runId,
                  machine: { sameMachine: {} },
                },
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
                result: {
                  success: {
                    agentId: subId,
                    isBackground: true,
                    durationMs: "819",
                    backgroundReason: "SUBAGENT_BACKGROUND_REASON_AGENT_REQUEST",
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
          message: { content: [{ type: "text", text: "Research Grok Bot transcripts" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "listing transcripts" },
              {
                type: "tool_use",
                name: "read",
                input: { path: "/home/box/sand-data/agent-transcripts" },
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
      const parsed = await parseGrokBotSession(join(root, parentId, `${parentId}.jsonl`));
      const agent = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agent?.type === "tool_use" && agent.input).toMatchObject({
        description: "Map Grok Bot sessions",
        prompt: "Research where Grok Bot stores conversation sessions.",
        subagent_type: "executor",
        sessionId: subId,
      });
      expect(agent?.type === "tool_use" && agent.input.sessionId).not.toBe(runId);
      expect(agent?.type === "tool_use" && agent._subAgent).toMatchObject({
        agentId: subId,
        description: "Map Grok Bot sessions",
        toolCalls: 1,
        thinkingBlocks: 1,
      });
      expect(parsed.subAgentSummary).toEqual([
        expect.objectContaining({
          agentId: subId,
          description: "Map Grok Bot sessions",
          toolCalls: 1,
        }),
      ]);

      const sessions = await discoverGrokBotSessions([root], false);
      expect(sessions.map((session) => session.sessionId)).toEqual([parentId]);
      expect(sessions.some((session) => session.sessionId.startsWith("sand-subagent-"))).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
