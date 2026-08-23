// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPerformance } from "../ProjectsPanel";
import type { ProjectInsights } from "../InsightsPanel";

afterEach(() => cleanup());

function projectInsights(): ProjectInsights {
  return {
    project: "~/code/example",
    sessionCount: 2,
    totalDurationMs: 30_000,
    totalCost: 1,
    totalPrompts: 4,
    totalToolCalls: 8,
    totalEdits: 2,
    models: {},
    branches: [],
    hotFiles: [],
    subAgentTotal: 0,
    apiErrorTotal: 0,
    timeRange: {
      first: "2026-08-01T00:00:00Z",
      last: "2026-08-02T00:00:00Z",
    },
    sessionsPerDay: {},
    avgSessionDurationMs: 15_000,
    turnDurationHistogram: {
      buckets: [
        { label: "<10s", minMs: 0, maxMs: 10_000, count: 1, pct: 50 },
        { label: "10–30s", minMs: 10_000, maxMs: 30_000, count: 1, pct: 50 },
      ],
      percentiles: { p50Ms: 8_000, p75Ms: 15_000, p90Ms: 20_000 },
      totalTurns: 2,
    },
    tokenBreakdown: {
      input: 100,
      output: 50,
      cacheRead: 1_000,
      cacheCreation: 200,
    },
  };
}

describe("ProjectPerformance", () => {
  it("renders project turn percentiles and token breakdown", () => {
    render(<ProjectPerformance insights={projectInsights()} loading={false} />);

    expect(screen.getByRole("heading", { name: "Performance" })).toBeDefined();
    expect(screen.getByText("P50")).toBeDefined();
    expect(screen.getByText("P75")).toBeDefined();
    expect(screen.getByText("P90")).toBeDefined();
    expect(screen.getByText("8s")).toBeDefined();
    expect(screen.getByText("Cache Read")).toBeDefined();
    expect(screen.getAllByText("1k")).toHaveLength(2);
  });

  it("keeps zero token categories visible", () => {
    render(
      <ProjectPerformance
        loading={false}
        insights={{
          ...projectInsights(),
          turnDurationHistogram: undefined,
          tokenBreakdown: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 },
        }}
      />,
    );

    expect(screen.getByText("Input")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Cache Read")).toBeDefined();
    expect(screen.getByText("Cache Write")).toBeDefined();
  });

  it("renders a loading state while detailed insights are fetched", () => {
    const { container } = render(<ProjectPerformance loading={true} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});
