import { describe, expect, it } from "vitest";
import { generateOtlpJson } from "../src/otel-export.js";
import type { ReplaySession } from "../src/types.js";

const replay: ReplaySession = {
  meta: {
    sessionId: "synthetic-session-1",
    slug: "synthetic-session",
    provider: "claude-code",
    startTime: "2026-09-01T12:00:00.000Z",
    cwd: "/private/project",
    project: "/private/project",
    generator: { name: "vibe-replay", version: "1.2.3", generatedAt: "2026-09-01T12:01:00Z" },
    stats: {
      sceneCount: 4,
      userPrompts: 1,
      toolCalls: 2,
      turnStats: [
        {
          turnIndex: 0,
          model: "claude-sonnet-4",
          tokenUsage: {
            inputTokens: 70,
            outputTokens: 20,
            cacheReadTokens: 25,
            cacheCreationTokens: 5,
          },
        },
      ],
    },
  },
  scenes: [
    { type: "user-prompt", content: "PRIVATE_PROMPT must not be exported" },
    {
      type: "tool-call",
      toolName: "Read",
      input: { file_path: "/private/project/secret.txt", content: "PRIVATE_ARGUMENT" },
      result: "PRIVATE_RESULT",
      hasResult: true,
      isError: false,
      timestamp: "2026-09-01T12:00:02.000Z",
      durationMs: 25,
      durationSource: "provider",
    },
    {
      type: "tool-call",
      toolName: "Bash",
      input: { command: "PRIVATE_COMMAND" },
      result: "",
      resultUnavailable: true,
      isError: false,
    },
    {
      type: "tool-call",
      isToolContainer: true,
      toolName: "Task",
      input: { prompt: "PRIVATE_WRAPPER" },
      result: "",
      hasResult: true,
      isError: false,
    },
  ],
};

describe("OTLP JSON export", () => {
  it("emits OTLP log records with semantic attributes and evidence quality", () => {
    const payload = JSON.parse(generateOtlpJson(replay));
    const resourceLog = payload.resourceLogs[0];
    const records = resourceLog.scopeLogs[0].logRecords;

    expect(resourceLog.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "vibe-replay" },
    });
    expect(records).toHaveLength(3);

    const toolRecord = records[0];
    expect(toolRecord.timeUnixNano).toBe("1788264002000000000");
    expect(toolRecord.attributes).toContainEqual({
      key: "gen_ai.operation.name",
      value: { stringValue: "execute_tool" },
    });
    expect(toolRecord.attributes).toContainEqual({
      key: "vibe_replay.tool.status",
      value: { stringValue: "success" },
    });
    expect(toolRecord.attributes).toContainEqual({
      key: "vibe_replay.quality.duration",
      value: { stringValue: "exact" },
    });
    expect(toolRecord.attributes).toContainEqual({
      key: "vibe_replay.duration.source",
      value: { stringValue: "provider" },
    });

    const unresolvedToolRecord = records[1];
    expect(unresolvedToolRecord.timeUnixNano).toBeUndefined();
    expect(unresolvedToolRecord.attributes).toContainEqual({
      key: "vibe_replay.tool.status",
      value: { stringValue: "unknown" },
    });
    expect(unresolvedToolRecord.attributes).toContainEqual({
      key: "vibe_replay.quality.duration",
      value: { stringValue: "unavailable" },
    });
  });

  it("keeps prompts, tool payloads, paths, and container calls out of the export", () => {
    const text = generateOtlpJson(replay);

    for (const privateValue of [
      "PRIVATE_PROMPT",
      "PRIVATE_ARGUMENT",
      "PRIVATE_RESULT",
      "PRIVATE_COMMAND",
      "PRIVATE_WRAPPER",
      "/private/project",
      "file_path",
    ]) {
      expect(text).not.toContain(privateValue);
    }
    expect(text).toContain('"gen_ai.tool.name"');
    expect(text).toContain('"gen_ai.response.model"');
  });

  it("exports cache-inclusive GenAI input tokens and preserves uncached input", () => {
    const payload = JSON.parse(generateOtlpJson(replay));
    const tokenRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[2];

    expect(tokenRecord.body.stringValue).toBe("vibe_replay.model_usage");
    expect(tokenRecord.attributes).toContainEqual({
      key: "gen_ai.usage.input_tokens",
      value: { intValue: "100" },
    });
    expect(tokenRecord.attributes).toContainEqual({
      key: "gen_ai.usage.cache_read.input_tokens",
      value: { intValue: "25" },
    });
    expect(tokenRecord.attributes).toContainEqual({
      key: "gen_ai.usage.cache_write.input_tokens",
      value: { intValue: "5" },
    });
    expect(tokenRecord.attributes).toContainEqual({
      key: "vibe_replay.usage.uncached_input_tokens",
      value: { intValue: "70" },
    });
    expect(tokenRecord.attributes).toContainEqual({
      key: "vibe_replay.quality.timestamp",
      value: { stringValue: "unavailable" },
    });
  });
});
