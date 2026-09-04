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
});
