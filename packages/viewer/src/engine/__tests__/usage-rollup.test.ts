import type { SessionUsageSummary } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import { rollupUsage, type UsageRollupSession } from "../usage-rollup.js";

function makeUsage(overrides: Partial<SessionUsageSummary> = {}): SessionUsageSummary {
  return {
    tools: {},
    mcpServers: {},
    mcpTools: {},
    skills: {},
    successCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    durationCount: 0,
    ...overrides,
  };
}

function makeSession(
  sessionId: string,
  usage: Partial<SessionUsageSummary>,
  startTime?: string,
): UsageRollupSession {
  return { provider: "cursor", sessionId, startTime, usage: makeUsage(usage) };
}

describe("rollupUsage", () => {
  it("sums calls and counts how many sessions used each name", () => {
    const rollup = rollupUsage([
      makeSession("a", { tools: { Bash: 10, Read: 2 } }),
      makeSession("b", { tools: { Bash: 5 } }),
    ]);

    expect(rollup.tools).toEqual([
      { name: "Bash", calls: 15, sessions: 2 },
      { name: "Read", calls: 2, sessions: 1 },
    ]);
    expect(rollup.sessionCount).toBe(2);
    expect(rollup.toolCalls).toBe(17);
  });

  it("counts MCP calls from servers so tool-less calls are not lost", () => {
    const rollup = rollupUsage([
      makeSession("a", {
        mcpServers: { sourcegraph: 3 },
        mcpTools: { "sourcegraph/search": 2 },
      }),
    ]);

    expect(rollup.mcpCalls).toBe(3);
    expect(rollup.mcpServers).toEqual([{ name: "sourcegraph", calls: 3, sessions: 1 }]);
    expect(rollup.mcpTools).toEqual([{ name: "sourcegraph/search", calls: 2, sessions: 1 }]);
  });

  it("normalizes placeholder MCP names from cached summaries", () => {
    const rollup = rollupUsage([
      makeSession("unknown", {
        mcpServers: { "-": 2 },
        mcpTools: { "-/search": 2 },
      }),
    ]);

    expect(rollup.mcpServers).toEqual([{ name: "Unknown", calls: 2, sessions: 1 }]);
    expect(rollup.mcpTools).toEqual([{ name: "Unknown/search", calls: 2, sessions: 1 }]);
  });

  it("keeps only sessions inside the requested range", () => {
    const rollup = rollupUsage(
      [
        makeSession("old", { tools: { Bash: 4 } }, "2026-01-01T00:00:00Z"),
        makeSession("new", { tools: { Bash: 1 } }, "2026-08-01T00:00:00Z"),
      ],
      { since: "2026-07-01T00:00:00Z" },
    );

    expect(rollup.tools).toEqual([{ name: "Bash", calls: 1, sessions: 1 }]);
    expect(rollup.sessionCount).toBe(1);
  });

  it("compares range boundaries by instant, not by string", () => {
    // 2026-08-01T01:00+08:00 is 2026-07-31T17:00Z — before the cutoff instant,
    // even though the string sorts after it.
    const rollup = rollupUsage(
      [makeSession("offset", { tools: { Bash: 2 } }, "2026-08-01T01:00:00+08:00")],
      {
        since: "2026-07-31T18:00:00Z",
      },
    );

    expect(rollup.sessionCount).toBe(0);
  });

  it("drops undated sessions from a range but keeps them all-time", () => {
    const sessions = [makeSession("undated", { tools: { Bash: 3 } })];

    expect(rollupUsage(sessions).sessionCount).toBe(1);
    expect(rollupUsage(sessions, { since: "2026-01-01T00:00:00Z" }).sessionCount).toBe(0);
  });

  it("ignores sessions whose counters are all empty", () => {
    const rollup = rollupUsage([
      makeSession("empty", {}),
      makeSession("a", { tools: { Bash: 1 } }),
    ]);

    expect(rollup.sessionCount).toBe(1);
  });

  it("ranks by calls, breaks ties alphabetically, and applies the limit", () => {
    const rollup = rollupUsage(
      [makeSession("a", { tools: { Read: 5, Bash: 5, Grep: 9, Edit: 1 } })],
      {
        limit: 3,
      },
    );

    expect(rollup.tools.map((entry) => entry.name)).toEqual(["Grep", "Bash", "Read"]);
  });

  it("totals success and error counts across sessions", () => {
    const rollup = rollupUsage([
      makeSession("a", { tools: { Bash: 2 }, successCount: 2, errorCount: 1 }),
      makeSession("b", { tools: { Bash: 1 }, successCount: 1, errorCount: 0 }),
    ]);

    expect(rollup.successCount).toBe(3);
    expect(rollup.errorCount).toBe(1);
  });
});
