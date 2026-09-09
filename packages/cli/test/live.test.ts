import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonlLiveSession } from "../src/server-routes/live.js";
import type { SessionInfo } from "../src/types.js";

const sessionInfo: SessionInfo = {
  provider: "grok-bot",
  sessionId: "grok-live-session",
  slug: "grok-live-session",
  project: "~/grok-bot",
  cwd: "~/grok-bot",
  version: "1",
  timestamp: "2026-01-01T00:00:00.000Z",
  lineCount: 0,
  fileSize: 0,
  filePath: "session.jsonl",
  filePaths: ["session.jsonl"],
  firstPrompt: "hello",
};

describe("live JSONL parsing", () => {
  it("uses the Grok Bot parser for Grok live sessions", async () => {
    const parsed = await parseJsonlLiveSession(
      "grok-bot",
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "[t0u] hello" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "send_message", input: { text: "hi there" } }],
          },
        }),
      ],
      sessionInfo,
      ["session.jsonl"],
    );

    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(parsed.turns[1]?.blocks[0]).toEqual({ type: "text", text: "hi there" });
  });

  it("attaches a sibling sand-subagent onto a live Grok Bot parent task card", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-grok-live-"));
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const subId = "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await mkdir(join(root, parentId), { recursive: true });
    await mkdir(join(root, subId), { recursive: true });
    const parentPath = join(root, parentId, `${parentId}.jsonl`);
    await writeFile(
      join(root, subId, `${subId}.jsonl`),
      `${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "opening spec" }] },
      })}\n`,
      "utf-8",
    );
    try {
      const parsed = await parseJsonlLiveSession(
        "grok-bot",
        [
          JSON.stringify({
            role: "user",
            message: { content: [{ type: "text", text: "explore the UI" }] },
          }),
          JSON.stringify({
            role: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "task",
                  toolCallId: "t-1",
                  input: { goal: "explore UI", sessionId: subId },
                },
              ],
            },
          }),
        ],
        { ...sessionInfo, filePath: parentPath, filePaths: [parentPath] },
        [parentPath],
      );
      const agent = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agent?.type === "tool_use" && agent._subAgent?.agentId).toBe(subId);
      expect(agent?.type === "tool_use" && agent._subAgent?.thinkingBlocks).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
