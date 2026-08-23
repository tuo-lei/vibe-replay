import { describe, expect, it } from "vitest";
import { rangeSince, rollupInsights, type InsightsRollupPayload } from "../insights-rollup";

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
});
