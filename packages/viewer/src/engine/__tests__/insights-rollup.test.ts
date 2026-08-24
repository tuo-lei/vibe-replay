import { describe, expect, it } from "vitest";
import {
  isInInsightsRange,
  rangeSince,
  rollupInsights,
  rollupInsightsBreakdown,
  type InsightsRollupPayload,
} from "../insights-rollup";

const payload: InsightsRollupPayload = {
  sessions: [
    {
      project: "~/code/recent",
      startTime: "2026-08-20T12:00:00-07:00",
      durationMs: 60_000,
      cost: 3,
      prompts: 10,
      edits: 8,
      toolCalls: 40,
    },
    {
      project: "~/code/recent",
      startTime: "2026-08-19T10:00:00Z",
      durationMs: 5_000,
      cost: 0.25,
      prompts: 2,
      edits: 1,
      toolCalls: 3,
    },
    {
      project: "~/code/old",
      startTime: "2026-01-01T00:00:00Z",
      durationMs: 600_000,
      cost: 20,
      prompts: 100,
      edits: 70,
      toolCalls: 400,
    },
    {
      project: "~/code/unknown",
      durationMs: 1_000,
      cost: 0.1,
      prompts: 1,
      edits: 0,
      toolCalls: 1,
    },
  ],
  replays: [
    {
      project: "~/code/recent",
      startTime: "2026-08-20T12:00:00-07:00",
    },
    {
      project: "~/code/old",
      startTime: "2026-01-01T00:00:00Z",
    },
    {
      project: "~/code/replay-only",
      startTime: "2026-08-18T09:00:00Z",
    },
    {
      project: "~/code/unknown",
    },
  ],
};

describe("rollupInsights", () => {
  it("sums exact metrics instead of scaling all-time totals", () => {
    expect(rollupInsights(payload, { since: "2026-08-15T00:00:00Z" })).toEqual({
      sessions: 2,
      replays: 2,
      durationMs: 65_000,
      cost: 3.25,
      prompts: 12,
      edits: 9,
      toolCalls: 43,
      projects: 2,
    });
  });

  it("keeps undated sessions and replays only in all-time totals", () => {
    expect(rollupInsights(payload)).toEqual({
      sessions: 4,
      replays: 4,
      durationMs: 666_000,
      cost: 23.35,
      prompts: 113,
      edits: 79,
      toolCalls: 444,
      projects: 4,
    });
  });

  it("compares offset timestamps as instants", () => {
    const result = rollupInsights(payload, { since: "2026-08-20T18:30:00Z" });
    expect(result.sessions).toBe(1);
    expect(result.prompts).toBe(10);
  });

  it("includes sessions exactly on the cutoff instant", () => {
    const result = rollupInsights(payload, { since: "2026-08-20T19:00:00Z" });
    expect(result.sessions).toBe(1);
    expect(result.durationMs).toBe(60_000);
  });

  it("starts each bounded range at local midnight", () => {
    const now = new Date(2026, 7, 20, 15, 30, 45, 123);
    const expected = new Date(now.getTime());
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - 6);

    expect(rangeSince("7d", now)).toBe(expected.toISOString());
    expect(rangeSince("30d", now)).toBe(
      (() => {
        const cutoff = new Date(now.getTime());
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - 29);
        return cutoff.toISOString();
      })(),
    );
    expect(rangeSince("all", now)).toBeUndefined();
  });

  it("keeps the local-day boundary inclusive across timestamp offsets", () => {
    const now = new Date(2026, 7, 20, 12);
    const since = rangeSince("7d", now)!;
    const result = rollupInsights(
      {
        sessions: [
          {
            project: "~/code/boundary",
            startTime: since,
            prompts: 1,
            edits: 0,
            toolCalls: 0,
          },
          {
            project: "~/code/boundary",
            startTime: new Date(Date.parse(since) - 1).toISOString(),
            prompts: 99,
            edits: 99,
            toolCalls: 99,
          },
        ],
        replays: [],
      },
      { since },
    );

    expect(result).toMatchObject({ sessions: 1, prompts: 1, edits: 0, toolCalls: 0 });
  });

  it.each([30, 500])("aggregates exact bounded totals for %d sessions", (sessionCount) => {
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      project: `~/code/project-${index % 2}`,
      startTime: "2026-08-20T12:00:00Z",
      durationMs: 1_000,
      cost: 0.25,
      prompts: 2,
      edits: 1,
      toolCalls: 3,
    }));
    const replays = sessions.map(({ project, startTime }) => ({ project, startTime }));

    expect(rollupInsights({ sessions, replays }, { since: "2026-08-20T00:00:00Z" })).toEqual({
      sessions: sessionCount,
      replays: sessionCount,
      durationMs: sessionCount * 1_000,
      cost: sessionCount * 0.25,
      prompts: sessionCount * 2,
      edits: sessionCount,
      toolCalls: sessionCount * 3,
      projects: 2,
    });
  });

  it("counts collapsed worktrees as one canonical project", () => {
    const project = "~/code/example";
    const worktree = `${project}/.claude/worktrees/feature`;
    const payload: InsightsRollupPayload = {
      sessions: [
        {
          project,
          startTime: "2026-08-20T12:00:00Z",
          prompts: 1,
          edits: 0,
          toolCalls: 0,
        },
        {
          project: worktree,
          startTime: "2026-08-20T13:00:00Z",
          prompts: 1,
          edits: 0,
          toolCalls: 0,
        },
      ],
      replays: [{ project: worktree, startTime: "2026-08-20T14:00:00Z" }],
    };

    expect(rollupInsights(payload).projects).toBe(1);
  });

  it("filters secondary breakdowns by the same session boundary", () => {
    const result = rollupInsightsBreakdown(
      {
        sessions: [
          {
            project: "~/code/recent",
            startTime: "2026-08-20T12:00:00Z",
            durationMs: 60_000,
            cost: 3,
            prompts: 10,
            edits: 8,
            toolCalls: 40,
            provider: "claude-code",
            model: "claude-sonnet-4",
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 30,
              cacheCreationTokens: 40,
            },
            turnDurations: [10_000, 45_000],
          },
          {
            project: "~/code/old",
            startTime: "2026-01-01T00:00:00Z",
            durationMs: 600_000,
            cost: 20,
            prompts: 100,
            edits: 70,
            toolCalls: 400,
            provider: "cursor",
            model: "gpt-4",
            tokenUsage: {
              inputTokens: 1_000,
              outputTokens: 2_000,
              cacheReadTokens: 3_000,
              cacheCreationTokens: 4_000,
            },
            turnDurations: [720_000],
          },
        ],
        replays: [],
      },
      { since: "2026-08-15T00:00:00Z" },
    );

    expect(result.projects).toEqual([
      {
        project: "~/code/recent",
        sessions: 1,
        cost: 3,
        prompts: 10,
        durationMs: 60_000,
        toolCalls: 40,
        edits: 8,
      },
    ]);
    expect(result.models).toEqual({ "claude-sonnet-4": 1 });
    expect(result.providers).toEqual({ "claude-code": 1 });
    expect(result.tokenBreakdown).toEqual({
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheCreation: 40,
    });
    expect(result.turnDurationHistogram).toMatchObject({
      totalTurns: 2,
      buckets: [
        { label: "<30s", count: 1, pct: 50 },
        { label: "30s-1m", count: 1, pct: 50 },
        { label: "1-2m", count: 0, pct: 0 },
        { label: "2-5m", count: 0, pct: 0 },
        { label: "5-10m", count: 0, pct: 0 },
        { label: "10m+", count: 0, pct: 0 },
      ],
      percentiles: { p50Ms: 27_500, p75Ms: 36_250, p90Ms: 41_500 },
    });
  });

  it("excludes undated sessions from bounded secondary breakdowns", () => {
    expect(isInInsightsRange(undefined, "2026-08-15T00:00:00Z")).toBe(false);
    expect(isInInsightsRange(undefined)).toBe(true);
  });
});
