// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TokenBreakdownChart, TurnDurationChart } from "../InsightCharts";

afterEach(cleanup);

describe("InsightCharts", () => {
  it("shows a compact total and token category breakdown", () => {
    render(
      <TokenBreakdownChart
        breakdown={{ input: 100, output: 50, cacheRead: 200, cacheCreation: 10 }}
      />,
    );

    expect(screen.getByText("Total")).toBeDefined();
    expect(screen.getByText("Cache Read")).toBeDefined();
    expect(screen.getByText("Cache Write")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Input (uncached)")).toBeDefined();
  });

  it("renders duration percentiles alongside the turn distribution", () => {
    render(
      <TurnDurationChart
        histogram={{
          buckets: [
            { label: "<30s", count: 1, pct: 50 },
            { label: "30s-1m", count: 1, pct: 50 },
          ],
          percentiles: { p50Ms: 20_000, p75Ms: 30_000, p90Ms: 40_000 },
          totalTurns: 2,
        }}
      />,
    );

    expect(screen.getByText("P50")).toBeDefined();
    expect(screen.getByText("P75")).toBeDefined();
    expect(screen.getByText("P90")).toBeDefined();
    expect(screen.getByText(/recorded and estimated turn durations/)).toBeDefined();
  });
});
