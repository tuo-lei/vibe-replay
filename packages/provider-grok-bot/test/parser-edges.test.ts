import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatAttachedImageMention,
  grokBotPathBasename,
  parseGrokBotLines,
  parseGrokBotSession,
  rewriteGrokBotShareableText,
  stripFileUrl,
} from "../src/grok-bot/parser.js";
import { transformToReplay } from "./helpers/transform.js";

describe("Grok Bot parser edges", () => {
  it("does not attach a later tool's result when names mismatch and ids are absent", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "read then maybe shell" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "read", input: { path: "/a.md" } }],
        },
      }),
      JSON.stringify({
        role: "tool",
        message: {
          content: [
            {
              type: "tool_result",
              name: "shell",
              result: { success: { stdout: "should not land on Read" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "Read" });
    expect(tools[0].type === "tool_use" && tools[0]._hasResult).toBe(false);
    expect(tools[0].type === "tool_use" && tools[0]._result).toBeUndefined();
  });

  it("consumes get_mcp_tools results positionally so they do not leak onto the next tool", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "list then read" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "get_mcp_tools", input: {} },
            { type: "tool_use", name: "read", input: { path: "/a.md" } },
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
              result: { success: { content: "github, slack" } },
            },
            {
              type: "tool_result",
              name: "read",
              result: { success: { content: "# doc" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "Read", _result: "# doc" });
    expect(JSON.stringify(parsed.turns)).not.toContain("github, slack");
  });

  it("keeps empty and error-shaped results without inventing success text", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "partial tools" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "read", toolCallId: "empty", input: { path: "/a.md" } },
            { type: "tool_use", name: "shell", toolCallId: "err", input: { command: "false" } },
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
              toolCallId: "empty",
              result: { success: { timestamp: 1788485460000 } },
            },
            {
              type: "tool_result",
              name: "shell",
              toolCallId: "err",
              result: { error: { message: "boom" } },
            },
          ],
        },
      }),
    ]);
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "Read", _hasResult: true, _result: "" });
    expect(tools[0].type === "tool_use" && tools[0]._isError).toBeUndefined();
    expect(tools[1]).toMatchObject({ name: "Bash", _isError: true, _result: "boom" });
  });

  it("skips non-object JSONL records and keeps a parse warning for truncated lines", () => {
    const parsed = parseGrokBotLines([
      "[1,2,3]",
      '{"role":"user"',
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "survived" }] },
      }),
    ]);
    expect(parsed.parseWarnings?.[0]).toMatchObject({
      kind: "malformed-json",
      firstLine: 2,
    });
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].blocks[0]).toEqual({ type: "text", text: "survived" });
  });

  it("rewrites Windows file URLs and titled markdown to basename mentions", () => {
    expect(stripFileUrl("file:///C:/Users/me/Pictures/cat.png")).toBe(
      "C:/Users/me/Pictures/cat.png",
    );
    expect(grokBotPathBasename("C:\\Users\\me\\Pictures\\cat.png")).toBe("cat.png");
    expect(formatAttachedImageMention("sketch", "file:///C:/Users/me/Pictures/cat.png")).toBe(
      "[attached image: sketch (cat.png)]",
    );
    expect(
      rewriteGrokBotShareableText('![cover](<file:///home/box/assets/cover.png> "hero")'),
    ).toBe("[attached image: cover (cover.png)]");
    expect(rewriteGrokBotShareableText("![x](file:///home/box/a.png)")).toBe(
      "[attached image: x (a.png)]",
    );
  });

  it("promotes attachment-only send_message instead of dropping the turn", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "send_message",
              input: {
                attachments: [
                  { url: "file:///home/box/agent-data/attachments/cat.png", title: "sketch" },
                ],
              },
            },
          ],
        },
      }),
    ]);
    expect(parsed.turns[0].blocks[0]).toEqual({
      type: "text",
      text: "[attached image: sketch (cat.png)]",
    });
  });

  it("does not throw when a parent task names a missing sibling subagent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-missing-sub-"));
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const subId = "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await mkdir(join(root, parentId), { recursive: true });
    await writeFile(
      join(root, parentId, `${parentId}.jsonl`),
      `${JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "task",
              toolCallId: "t-1",
              input: { goal: "explore", sessionId: subId },
            },
          ],
        },
      })}\n`,
      "utf-8",
    );
    try {
      const parsed = await parseGrokBotSession(join(root, parentId, `${parentId}.jsonl`));
      const agent = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agent?.type === "tool_use" && agent._subAgent).toBeUndefined();
      expect(parsed.subAgentSummary).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expand nested grandchildren when attaching a sand-subagent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-nested-sub-"));
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const grandId = "sand-subagent-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await mkdir(join(root, parentId), { recursive: true });
    await mkdir(join(root, childId), { recursive: true });
    await mkdir(join(root, grandId), { recursive: true });
    await writeFile(
      join(root, parentId, `${parentId}.jsonl`),
      `${JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "task",
              toolCallId: "t-1",
              input: { goal: "explore UI", sessionId: childId },
            },
          ],
        },
      })}\n`,
      "utf-8",
    );
    await writeFile(
      join(root, childId, `${childId}.jsonl`),
      [
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "task",
                toolCallId: "t-2",
                input: { goal: "nested", sessionId: grandId },
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
      join(root, grandId, `${grandId}.jsonl`),
      `${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "grandchild scratch" }] },
      })}\n`,
      "utf-8",
    );
    try {
      const parsed = await parseGrokBotSession(join(root, parentId, `${parentId}.jsonl`));
      const agent = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agent?.type === "tool_use" && agent._subAgent?.agentId).toBe(childId);
      const nested = agent?.type === "tool_use" ? agent._subAgent?.scenes : undefined;
      expect(nested?.some((scene) => JSON.stringify(scene).includes("grandchild scratch"))).toBe(
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("smoke-transforms a live-shaped stub: media scrub, MCP, wake, and status tool", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "[A background task just completed]\nWrote recap." }],
        },
      }),
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "[t0u]\n一起画画" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "private scratch" },
            {
              type: "tool_use",
              name: "communicate_update",
              toolCallId: "cu-1",
              input: { text: { content: "Sketching now." } },
            },
            {
              type: "tool_use",
              name: "mcp",
              toolCallId: "m-1",
              input: { server: "github", toolName: "pull_request_read" },
            },
            {
              type: "tool_use",
              name: "generate_image",
              toolCallId: "img-1",
              input: { prompt: "a cat" },
            },
            {
              type: "tool_use",
              name: "send_message",
              input: {
                text: {
                  content: "See ![cat](<file:///home/box/agent-data/attachments/cat.png>)",
                },
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
              toolCallId: "cu-1",
              result: { success: { timestamp: 1788485600000 } },
            },
            {
              type: "tool_result",
              name: "mcp",
              toolCallId: "m-1",
              result: { success: { timestamp: 1788485601000, content: "PR 1" } },
            },
            {
              type: "tool_result",
              name: "generate_image",
              toolCallId: "img-1",
              result: {
                success: {
                  timestamp: 1788485602000,
                  filePath: "/home/box/agent-data/assets/cat.png",
                  imageData: `iVBOR${"A".repeat(120)}`,
                },
              },
            },
          ],
        },
      }),
    ]);
    const prompts = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(prompts[0].blocks[0]).toEqual({ type: "text", text: "一起画画" });
    expect(parsed.turns.some((turn) => turn.subtype === "context-injection")).toBe(true);

    const replay = transformToReplay(parsed, "grok-bot", "~/grok-bot");
    const types = replay.scenes.map((scene) => scene.type);
    expect(types).toContain("context-injection");
    expect(types).toContain("user-prompt");
    expect(types).toContain("thinking");
    expect(types).toContain("text-response");
    expect(types).toContain("tool-call");
    const user = replay.scenes.find((scene) => scene.type === "user-prompt");
    expect(user?.type === "user-prompt" && user.content).toBe("一起画画");
    expect(
      replay.scenes.some(
        (scene) => scene.type === "text-response" && scene.content.includes("[attached image: cat"),
      ),
    ).toBe(true);
    expect(JSON.stringify(replay.scenes)).not.toContain("iVBOR");
    expect(JSON.stringify(replay.scenes)).not.toContain("file://");
    expect(
      replay.scenes.some(
        (scene) =>
          scene.type === "tool-call" && scene.toolName === "mcp__github__pull_request_read",
      ),
    ).toBe(true);
    const status = replay.scenes.find(
      (scene) => scene.type === "tool-call" && scene.toolName === "CommunicateUpdate",
    );
    expect(status?.type === "tool-call" && status.input.update).toBe("Sketching now.");
  });
});
