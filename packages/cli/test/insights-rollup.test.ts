import { describe, expect, it } from "vitest";
import { buildInsightsRollup } from "../src/insights-rollup.js";
import type { SessionScanResult } from "../src/scanner.js";
import type { ReplaySummary } from "../src/server-types.js";

function makeScan(overrides: Partial<SessionScanResult> = {}): SessionScanResult {
  return {
    sessionId: "session-a",
    provider: "claude-code",
    project: "~/Code/app",
    slug: "session-a",
    startTime: "2026-08-20T10:00:00.000Z",
    durationMs: 60_000,
    promptCount: 2,
    toolCallCount: 5,
    editCount: 1,
    filesModified: [{ file: "src/app.ts", count: 1 }],
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    },
    costEstimate: 0.25,
    firstPrompt: "private prompt content",
    usageEvents: [
      {
        kind: "tool",
        name: "Read",
        status: "success",
        attribution: "explicit",
      },
    ],
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    ...overrides,
  };
}

function makeReplay(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    slug: "replay-a",
    baseDir: "/tmp/vibe-replay",
    sessionId: "session-a",
    title: "private replay title",
    provider: "claude-code",
    project: "~/Code/app",
    startTime: "2026-08-20T10:00:00.000Z",
    stats: {
      sceneCount: 4,
      userPrompts: 2,
      toolCalls: 5,
      thinkingBlocks: 1,
      durationMs: 60_000,
      costEstimate: 0.25,
    },
    replaySize: 123,
    replayOutdated: false,
    hasAnnotations: false,
    annotationCount: 0,
    messages: ["private replay content"],
    ...overrides,
  };
}

describe("buildInsightsRollup", () => {
  it("can include secondary range fields without conversation content", () => {
    const payload = buildInsightsRollup(
      [
        makeScan({
          model: "claude-sonnet-4",
          turnDurations: [10_000, 45_000],
          turnMetrics: [
            { durationMs: 10_000, toolCalls: 2, tokens: 100 },
            { durationMs: 45_000, toolCalls: 3, tokens: 200 },
          ],
        }),
      ],
      [],
      { includeDetails: true },
    );

    expect(payload.sessions[0]).toMatchObject({
      provider: "claude-code",
      model: "claude-sonnet-4",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      },
      turnDurations: [10_000, 45_000],
      turnMetrics: [
        { durationMs: 10_000, toolCalls: 2, tokens: 100 },
        { durationMs: 45_000, toolCalls: 3, tokens: 200 },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("private");
  });

  it("keeps only compact additive metrics and timestamps", () => {
    const payload = buildInsightsRollup(
      [makeScan()],
      [makeReplay({ project: "~/Code/replay", startTime: "2026-08-19T10:00:00.000Z" })],
    );

    expect(payload).toEqual({
      sessions: [
        {
          project: "~/Code/app",
          startTime: "2026-08-20T10:00:00.000Z",
          durationMs: 60_000,
          cost: 0.25,
          prompts: 2,
          edits: 1,
          toolCalls: 5,
        },
      ],
      replays: [{ project: "~/Code/replay", startTime: "2026-08-19T10:00:00.000Z" }],
    });
    expect(JSON.stringify(payload)).not.toContain("private");
  });

  it.each([30, 500])("keeps a %d-session scan set compact", (sessionCount) => {
    const scans = Array.from({ length: sessionCount }, (_, index) =>
      makeScan({
        sessionId: `session-${index}`,
        slug: `session-${index}`,
        project: `~/Code/app-${index % 3}`,
        usageEvents: Array.from({ length: 30 }, (_, eventIndex) => ({
          kind: "tool",
          name: `tool-${eventIndex}`,
          status: "success",
          attribution: "explicit",
        })),
      }),
    );

    const payload = buildInsightsRollup(scans, []);

    expect(payload.sessions).toHaveLength(sessionCount);
    expect(payload.sessions[0]).toEqual({
      project: "~/Code/app-0",
      startTime: "2026-08-20T10:00:00.000Z",
      durationMs: 60_000,
      cost: 0.25,
      prompts: 2,
      edits: 1,
      toolCalls: 5,
    });
    expect(JSON.stringify(payload)).not.toContain("tool-");
  });
});
