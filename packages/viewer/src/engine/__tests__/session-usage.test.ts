import type { SessionUsageSummary } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import { summarizeSessionUsage } from "../session-usage.js";

function makeSummary(overrides: Partial<SessionUsageSummary> = {}): SessionUsageSummary {
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

describe("summarizeSessionUsage", () => {
  it("ranks tools by count and breaks ties alphabetically", () => {
    const breakdown = summarizeSessionUsage(
      makeSummary({ tools: { Read: 5, Bash: 12, Grep: 5, Edit: 1 } }),
    );

    expect(breakdown?.tools.map((entry) => entry.name)).toEqual(["Bash", "Grep", "Read", "Edit"]);
    expect(breakdown?.totalCalls).toBe(23);
  });

  it("adds MCP calls to the total without double-counting untyped ones", () => {
    const breakdown = summarizeSessionUsage(
      makeSummary({
        tools: { Bash: 2 },
        // One sourcegraph call never named a tool, so mcpTools sums to 4, not 5.
        mcpServers: { sourcegraph: 3, slack: 2 },
        mcpTools: { "sourcegraph/search": 2, "slack/read": 2 },
      }),
    );

    expect(breakdown?.totalCalls).toBe(7);
  });

  it("limits each list and counts distinct MCP servers", () => {
    const breakdown = summarizeSessionUsage(
      makeSummary({
        tools: { a: 9, b: 8, c: 7, d: 6 },
        mcpServers: { sourcegraph: 5, slack: 2 },
        mcpTools: { "sourcegraph/search": 4, "sourcegraph/get_file": 1, "slack/read": 2 },
      }),
      2,
    );

    expect(breakdown?.tools).toHaveLength(2);
    expect(breakdown?.mcpTools.map((entry) => entry.name)).toEqual([
      "sourcegraph/search",
      "slack/read",
    ]);
    expect(breakdown?.mcpServerCount).toBe(2);
  });

  it("averages duration only over calls that reported one", () => {
    const breakdown = summarizeSessionUsage(
      makeSummary({ tools: { Bash: 4 }, totalDurationMs: 900, durationCount: 3 }),
    );

    expect(breakdown?.avgDurationMs).toBe(300);
  });

  it("omits the average when no call reported a duration", () => {
    const breakdown = summarizeSessionUsage(makeSummary({ tools: { Bash: 2 } }));

    expect(breakdown?.avgDurationMs).toBeUndefined();
  });

  it("returns undefined when there is nothing indexed", () => {
    expect(summarizeSessionUsage(undefined)).toBeUndefined();
    expect(summarizeSessionUsage(makeSummary())).toBeUndefined();
  });

  it("still reports skill-only sessions", () => {
    const breakdown = summarizeSessionUsage(makeSummary({ skills: { replay: 1 } }));

    expect(breakdown?.skills).toEqual([{ name: "replay", count: 1 }]);
    expect(breakdown?.totalCalls).toBe(0);
  });
});
