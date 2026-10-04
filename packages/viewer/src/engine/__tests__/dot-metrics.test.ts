import { expect, it } from "vitest";
import { buildSessionMetricDistributions, rollupInsightsBreakdown } from "../insights-rollup";

it("excludes dot's unavailable session tools and stale per-turn metrics from distributions", () => {
  const session = {
    provider: "dot",
    project: "dot conversations",
    startTime: "2026-10-04T01:00:00Z",
    prompts: 2,
    edits: 0,
    toolCalls: 0,
    turnMetrics: [{ toolCalls: 0 }],
  };
  expect(buildSessionMetricDistributions([session])?.toolCalls).toBeUndefined();
  expect(buildSessionMetricDistributions([session])?.turns?.sampleCount).toBe(1);
  const breakdown = rollupInsightsBreakdown({ sessions: [session], replays: [] });
  expect(breakdown.perTurnDistributions).toBeUndefined();
});
