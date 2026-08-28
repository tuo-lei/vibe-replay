import { describe, expect, it } from "vitest";
import { buildUsageCoverageReport } from "../src/usage-coverage.js";
import type { SessionScanResult } from "../src/scanner.js";

function scan(overrides: Partial<SessionScanResult> = {}): SessionScanResult {
  return {
    sessionId: "session",
    provider: "claude-code",
    project: "~/project",
    slug: "session",
    promptCount: 1,
    toolCallCount: 0,
    editCount: 0,
    filesModified: [],
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    usageIndexed: true,
    ...overrides,
  };
}

const usage = {
  tools: { Bash: 2 },
  mcpServers: { slack: 1 },
  mcpTools: { "slack/search": 1 },
  skills: {},
  successCount: 3,
  errorCount: 0,
  totalDurationMs: 0,
  durationCount: 0,
};

describe("buildUsageCoverageReport", () => {
  it("separates index completion from metric availability and derives cache misses", () => {
    const report = buildUsageCoverageReport([
      scan({
        sessionId: "cursor-rich",
        provider: "cursor",
        toolCallCount: 3,
        usageSummary: usage,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheCreationTokens: 10,
        },
        compactionCount: 1,
      }),
      scan({
        sessionId: "cursor-pending",
        provider: "cursor",
        toolCallCount: 2,
        usageIndexed: false,
      }),
      scan({
        sessionId: "claude-empty",
        provider: "claude-code",
      }),
    ]);

    expect(report.totalSessions).toBe(3);
    expect(report.indexedSessions).toBe(2);
    expect(report.missingInvocationSessions).toBe(1);
    expect(report.promptTokens).toBe(410);
    expect(report.cacheMissTokens).toBe(110);

    const cursor = report.providers.find((provider) => provider.provider === "cursor");
    expect(cursor).toMatchObject({
      totalSessions: 2,
      indexedSessions: 1,
      invocationSessions: 1,
      invocationCalls: 3,
      mcpCalls: 1,
      mcpToolCalls: 1,
      tokenSessions: 1,
      compactionSessions: 1,
      compactionCount: 1,
      metrics: {
        invocations: { quality: "partial" },
        mcpTools: { quality: "exact" },
        tokens: { quality: "partial" },
        cache: { quality: "partial" },
        compactions: { quality: "partial" },
      },
    });
  });

  it("treats an indexed zero-invocation session as complete rather than missing", () => {
    const report = buildUsageCoverageReport([
      scan({ provider: "opencode", sessionId: "empty", usageIndexed: true }),
    ]);

    expect(report.missingInvocationSessions).toBe(0);
    expect(report.providers[0]?.metrics.invocations).toEqual({
      availableSessions: 1,
      totalSessions: 1,
      quality: "exact",
    });
    expect(report.providers[0]?.metrics.compactions.quality).toBe("exact");
  });
});
