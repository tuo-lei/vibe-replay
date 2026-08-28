import type { InsightsStore, SessionInsight } from "@vibe-replay/types";
import { INSIGHTS_SCHEMA_VERSION } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import {
  aggregateDailyInsights,
  getInsightsStats,
  mergeInsights,
  scanResultToInsight,
} from "../src/insights.js";
import type { SessionScanResult } from "../src/scanner.js";

function makeScan(overrides: Partial<SessionScanResult> = {}): SessionScanResult {
  return {
    sessionId: "session-a",
    provider: "claude-code",
    project: "~/Code/app",
    slug: "session-a",
    startTime: "2026-05-01T10:00:00.000Z",
    durationMs: 60_000,
    model: "claude-sonnet-4-20250514",
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
    subAgentCount: 1,
    apiErrorCount: 0,
    compactionCount: 0,
    dataSource: "jsonl",
    ...overrides,
  };
}

function makeInsight(overrides: Partial<SessionInsight> = {}): SessionInsight {
  return {
    sessionId: "session-a",
    slug: "session-a",
    provider: "claude-code",
    project: "~/Code/app",
    startTime: "2026-04-30T10:00:00.000Z",
    promptCount: 1,
    toolCallCount: 1,
    editCount: 0,
    hasPR: false,
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    capturedAt: "2026-04-30T11:00:00.000Z",
    capturedByVersion: "0.0.0",
    machineId: "machine-original",
    machineName: "Original Machine",
    ...overrides,
  };
}

function makeStore(sessions: SessionInsight[]): InsightsStore {
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    lastUpdated: "2026-05-01T00:00:00.000Z",
    sessions,
  };
}

describe("scanResultToInsight", () => {
  it("maps scan metadata into durable insight records", () => {
    const insight = scanResultToInsight(
      makeScan({
        prLinks: [
          {
            prNumber: 42,
            prUrl: "https://github.com/tuo-lei/app/pull/42",
            prRepository: "tuo-lei/app",
          },
        ],
        skillsUsed: ["replay"],
        usageSummary: {
          tools: { Read: 1 },
          mcpServers: {},
          mcpTools: {},
          skills: { replay: 1 },
          successCount: 1,
          errorCount: 0,
          totalDurationMs: 25,
          durationCount: 1,
        },
        usageEvents: [
          {
            kind: "tool",
            name: "Read",
            status: "success",
            durationMs: 25,
            attribution: "explicit",
          },
        ],
      }),
    );

    expect(insight).toMatchObject({
      sessionId: "session-a",
      provider: "claude-code",
      project: "~/Code/app",
      hasPR: true,
      prLinks: [
        {
          prNumber: 42,
          prUrl: "https://github.com/tuo-lei/app/pull/42",
          prRepository: "tuo-lei/app",
        },
      ],
      skillsUsed: ["replay"],
      usageSummary: { tools: { Read: 1 }, skills: { replay: 1 } },
      usageEvents: [{ kind: "tool", name: "Read", status: "success" }],
      filesModified: [{ file: "src/app.ts", count: 1 }],
      dataSource: "jsonl",
    });
    expect(typeof insight.capturedAt).toBe("string");
    expect(typeof insight.capturedByVersion).toBe("string");
  });

  it("omits empty file lists and marks missing PRs as false", () => {
    const insight = scanResultToInsight(makeScan({ filesModified: [], prLinks: [] }));

    expect(insight.filesModified).toBeUndefined();
    expect(insight.hasPR).toBe(false);
  });
});

describe("mergeInsights", () => {
  it("upserts fresh scans while preserving original capture provenance", () => {
    const existing = makeInsight();
    const stale = makeInsight({ sessionId: "deleted-source", slug: "deleted-source" });

    const merged = mergeInsights(makeStore([existing, stale]), [
      makeScan({ promptCount: 7 }),
      makeScan({ sessionId: "session-b", slug: "session-b", promptCount: 3 }),
    ]);

    expect(merged.schemaVersion).toBe(INSIGHTS_SCHEMA_VERSION);
    expect(merged.sessions.map((s) => s.sessionId)).toEqual([
      "session-a",
      "deleted-source",
      "session-b",
    ]);
    const updated = merged.sessions.find((s) => s.sessionId === "session-a");
    expect(updated).toMatchObject({
      promptCount: 7,
      capturedAt: "2026-04-30T11:00:00.000Z",
      machineId: "machine-original",
      machineName: "Original Machine",
    });
    expect(updated?.updatedAt).toBeDefined();
  });

  it("keeps identical native session IDs isolated by provider", () => {
    const merged = mergeInsights(
      makeStore([
        makeInsight({ provider: "claude-code", sessionId: "shared", promptCount: 1 }),
        makeInsight({ provider: "cursor", sessionId: "shared", promptCount: 2 }),
      ]),
      [
        makeScan({ provider: "cursor", sessionId: "shared", promptCount: 7 }),
        makeScan({ provider: "pi", sessionId: "shared", promptCount: 3 }),
      ],
    );

    expect(
      merged.sessions.map((session) => [session.provider, session.sessionId, session.promptCount]),
    ).toEqual([
      ["claude-code", "shared", 1],
      ["cursor", "shared", 7],
      ["pi", "shared", 3],
    ]);
  });

  it("does not overwrite a durable record with a partial scan placeholder", () => {
    const existing = makeInsight({
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
      },
      toolCallCount: 12,
    });
    const merged = mergeInsights(makeStore([existing]), [
      makeScan({
        dataQualityNotes: [
          "Partial cursor scan: the source could not be read, so discovery metadata was retained.",
        ],
        tokenUsage: undefined,
        toolCallCount: 0,
      }),
    ]);

    expect(merged.sessions[0]).toMatchObject({
      toolCallCount: 12,
      tokenUsage: existing.tokenUsage,
    });
  });
});

describe("aggregateDailyInsights", () => {
  it("groups sessions by local day with JSON breakdowns", () => {
    const may1Morning = new Date(2026, 4, 1, 10).toISOString();
    const may1Noon = new Date(2026, 4, 1, 12).toISOString();
    const may2Morning = new Date(2026, 4, 2, 10).toISOString();
    const aggregate = aggregateDailyInsights(
      makeStore([
        makeInsight({
          sessionId: "session-a",
          project: "~/Code/app",
          provider: "claude-code",
          model: "sonnet",
          startTime: may1Morning,
          promptCount: 2,
          toolCallCount: 3,
          editCount: 1,
          durationMs: 10_000,
          costEstimate: 0.1,
        }),
        makeInsight({
          sessionId: "session-b",
          project: "~/Code/app",
          provider: "cursor",
          model: "gpt-5.5",
          startTime: may1Noon,
          promptCount: 4,
          toolCallCount: 5,
          editCount: 2,
          durationMs: 20_000,
          costEstimate: 0.2,
        }),
        makeInsight({
          sessionId: "session-c",
          project: "~/Code/other",
          provider: "claude-code",
          startTime: may2Morning,
          promptCount: 1,
        }),
        makeInsight({
          sessionId: "remote-session",
          project: "~/remote/project",
          provider: "codex",
          location: { kind: "ssh", id: "remote-dev", label: "Remote dev" },
          startTime: may1Noon,
          promptCount: 99,
          toolCallCount: 99,
          costEstimate: 99,
        }),
        makeInsight({ sessionId: "missing-time", startTime: undefined }),
      ]),
    );

    expect(aggregate.days.map((day) => day.date)).toEqual(["2026-05-01", "2026-05-02"]);
    expect(aggregate.days[0]).toMatchObject({
      sessions: 2,
      prompts: 6,
      toolCalls: 8,
      edits: 3,
      durationMs: 30_000,
    });
    expect(aggregate.days[0].cost).toBeCloseTo(0.3);
    expect(JSON.parse(aggregate.days[0].projects)).toMatchObject({
      "~/Code/app": { sessions: 2, prompts: 6, toolCalls: 8, edits: 3, durationMs: 30_000 },
    });
    expect(JSON.parse(aggregate.days[0].models)).toEqual({
      sonnet: { sessions: 1, cost: 0.1 },
      "gpt-5.5": { sessions: 1, cost: 0.2 },
    });
    expect(JSON.parse(aggregate.days[0].providers)).toEqual({
      "claude-code": { sessions: 1, cost: 0.1 },
      cursor: { sessions: 1, cost: 0.2 },
    });
  });
});

describe("getInsightsStats", () => {
  it("counts providers and unique projects", () => {
    const stats = getInsightsStats(
      makeStore([
        makeInsight({ sessionId: "a", provider: "claude-code", project: "~/Code/app" }),
        makeInsight({ sessionId: "b", provider: "cursor", project: "~/Code/app" }),
        makeInsight({ sessionId: "c", provider: "cursor", project: "~/Code/other" }),
      ]),
    );

    expect(stats).toEqual({
      total: 3,
      providers: { "claude-code": 1, cursor: 2 },
      projects: 2,
    });
  });
});
