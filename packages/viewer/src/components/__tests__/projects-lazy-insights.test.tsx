// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectsPanel from "../ProjectsPanel";
import * as InsightsPanel from "../InsightsPanel";

vi.mock("../SessionRelationshipsView", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function contextValue(): ReturnType<typeof InsightsPanel.useScanInsightsContext> {
  return {
    scanStatus: {
      running: false,
      scanned: 2,
      total: 2,
      resultCount: 2,
    },
    userInsights: {
      totalSessions: 2,
      totalProjects: 1,
      totalDurationMs: 30_000,
      totalCost: 1,
      totalPrompts: 4,
      totalToolCalls: 8,
      totalEdits: 2,
      providers: {},
      topProjects: [
        {
          project: "~/code/example",
          sessions: 2,
          cost: 1,
          prompts: 4,
          durationMs: 30_000,
          toolCalls: 8,
          edits: 2,
          branchCount: 0,
          prCount: 0,
          memoryFileCount: 0,
          lastActivity: "2026-08-20T00:00:00Z",
          sessionsPerDay: {},
        },
      ],
      models: {},
      timeRange: { first: "2026-08-19T00:00:00Z", last: "2026-08-20T00:00:00Z" },
      sessionsPerDay: {},
      subAgentTotal: 0,
      apiErrorTotal: 0,
      avgSessionDurationMs: 15_000,
    },
    projectInsightsCache: new Map(),
    fetchProjectInsights: vi.fn(),
    loading: false,
  };
}

describe("ProjectsPanel project insights", () => {
  it("opens the Timeline view by default and when selecting a project", () => {
    const context = contextValue();
    vi.spyOn(InsightsPanel, "useScanInsightsContext").mockReturnValue(context);

    render(<ProjectsPanel onNavigate={vi.fn()} />);

    const timelineTab = screen.getByRole("button", { name: "Timeline" });
    expect(timelineTab.className).toContain("bg-terminal-green-subtle");

    const overviewTab = screen.getByRole("button", { name: "Overview" });
    fireEvent.click(overviewTab);
    expect(overviewTab.className).toContain("bg-terminal-green-subtle");

    fireEvent.click(screen.getAllByRole("button", { name: /example/i })[0]);

    expect(screen.getByRole("heading", { name: /example/i })).toBeDefined();
    expect(timelineTab.className).toContain("bg-terminal-green-subtle");
  });

  it("fetches detailed insights only after selecting a project", () => {
    const context = contextValue();
    vi.spyOn(InsightsPanel, "useScanInsightsContext").mockReturnValue(context);

    render(<ProjectsPanel onNavigate={vi.fn()} />);
    expect(context.fetchProjectInsights).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: /example/i })[0]);

    expect(context.fetchProjectInsights).toHaveBeenCalledTimes(1);
    expect(context.fetchProjectInsights).toHaveBeenCalledWith("~/code/example");
  });

  it("keeps hidden agent-run activity in the default parent rollup", () => {
    const context = contextValue();
    context.userInsights!.topProjects.push({
      ...context.userInsights!.topProjects[0],
      project: "~/code/example/run-abcdef123456",
      sessions: 1,
      cost: 0.5,
      prompts: 1,
      durationMs: 1_000,
      toolCalls: 1,
      edits: 0,
      lastActivity: "2026-08-21T00:00:00Z",
    });
    vi.spyOn(InsightsPanel, "useScanInsightsContext").mockReturnValue(context);

    render(<ProjectsPanel onNavigate={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /example/i })[0]?.textContent).toContain("3");
  });
});
