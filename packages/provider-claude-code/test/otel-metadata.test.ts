import { describe, expect, it } from "vitest";
import { parseClaudeCodeLines } from "../src/claude-code/parser.js";

describe("Claude Code OTel metadata", () => {
  it("uses the first assistant timestamp with positive token usage", async () => {
    const lines = [
      {
        type: "user",
        timestamp: "2026-03-20T10:00:01.000Z",
        sessionId: "otel-metadata",
        cwd: "/tmp/project",
        message: { role: "user", content: "Prompt" },
      },
      {
        type: "assistant",
        timestamp: "2026-03-20T10:00:02.000Z",
        message: {
          id: "assistant-zero",
          role: "assistant",
          model: "fixture-model",
          content: [{ type: "text", text: "No usage" }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-03-20T10:00:03.000Z",
        message: {
          id: "assistant-positive",
          role: "assistant",
          model: "fixture-model",
          content: [{ type: "text", text: "Usage recorded" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ].map((line) => JSON.stringify(line));

    const parsed = await parseClaudeCodeLines(lines);

    expect(parsed.turnStats?.[0]).toMatchObject({
      timestamp: "2026-03-20T10:00:03.000Z",
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
    });
  });
});
