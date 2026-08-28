// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InsightsSection,
  InsightsSectionNav,
  navigateToUsageSessions,
  TopProjectsList,
  CoverageAudit,
  formatCompactNum,
  UsageBarList,
  UsageCoverage,
} from "../InsightsPage";
import { getInsightsRangeFromUrl, getMultiFromUrl } from "../../hooks/usePanelFilters";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("UsageBarList", () => {
  it("opens matching sessions when an entry is selected", () => {
    const onSelect = vi.fn();
    render(
      <UsageBarList
        entries={[{ name: "sourcegraph/search", calls: 12, sessions: 3 }]}
        emptyLabel="No MCP data"
        unit="calls"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /sourcegraph\/search/i }));

    expect(onSelect).toHaveBeenCalledWith("sourcegraph/search");
  });

  it("navigates to Sessions with only the selected usage facet", () => {
    window.history.replaceState(
      {},
      "",
      "/?view=dashboard&tab=insights&project=old&tool=Read&archived=true&agentRuns=true&replay=old",
    );

    navigateToUsageSessions("mcpTool", "sourcegraph/search");

    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("sessions");
    for (const key of ["project", "q", "provider", "repo", "tool", "mcp", "skill", "replay"]) {
      expect(params.get(key), `${key} should be cleared`).toBeNull();
    }
    expect(params.get("archived")).toBe("true");
    expect(params.get("agentRuns")).toBe("true");
    expect(params.get("mcpTool")).toBe("sourcegraph/search");
  });

  it.each([
    ["tool", "Read"],
    ["mcp", "sourcegraph"],
    ["mcpTool", "sourcegraph/search"],
    ["skill", "replay"],
  ] as const)("supports the %s URL facet", (facet, value) => {
    navigateToUsageSessions(facet, value);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("tab")).toBe("sessions");
    expect(params.get(facet)).toBe(value);
  });

  it("preserves the selected Insights range in the Sessions URL", () => {
    navigateToUsageSessions("tool", "Read", "7d");

    expect(new URLSearchParams(window.location.search).get("insightsRange")).toBe("7d");
  });

  it("reads only supported Insights ranges from the URL", () => {
    window.history.replaceState({}, "", "/?insightsRange=30d");
    expect(getInsightsRangeFromUrl()).toBe("30d");

    window.history.replaceState({}, "", "/?insightsRange=invalid");
    expect(getInsightsRangeFromUrl()).toBe("all");
  });

  it("round-trips facet names with URL-sensitive characters exactly once", () => {
    const value = "sourcegraph/search?query=foo bar&scope=100%,comma";

    navigateToUsageSessions("mcpTool", value);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("mcpTool")).toBe(value);
    expect(getMultiFromUrl("mcpTool")).toEqual([value]);
  });
});

describe("insight metric formatting", () => {
  it("rounds animated intermediate values so metric cards cannot overflow", () => {
    expect(formatCompactNum(555.225)).toBe("555");
    expect(formatCompactNum(158_900.4)).toBe("158.9k");
  });
});

describe("Insights sections", () => {
  it("exposes section anchors and navigates from the sidebar", () => {
    const onSelect = vi.fn();
    render(
      <>
        <InsightsSectionNav activeSection="overview" onSelect={onSelect} />
        <InsightsSection
          id="usage"
          eyebrow="03 / Usage"
          title="How your agents work"
          description="Invocation counts"
        >
          <div>Usage content</div>
        </InsightsSection>
      </>,
    );

    const usageButton = screen.getByRole("button", { name: /Usage/i });
    expect(usageButton.getAttribute("aria-controls")).toBe("insights-usage");
    expect(screen.getByRole("heading", { name: "How your agents work" })).toBeDefined();
    expect(document.getElementById("insights-usage")).not.toBeNull();

    fireEvent.click(usageButton);
    expect(onSelect).toHaveBeenCalledWith("usage");
  });

  it("communicates incomplete invocation-index coverage", () => {
    const { container } = render(
      <UsageCoverage
        payload={{
          sessions: [],
          indexedSessions: 2,
          totalSessions: 4,
        }}
      />,
    );

    expect(container.textContent).toContain("2 / 4 sessions");
    expect(container.textContent).toContain("50% indexed");
    expect(container.textContent).toContain("Counts will grow");
  });

  it("shows provider precision and derived cache-miss coverage", () => {
    render(
      <CoverageAudit
        report={{
          totalSessions: 2,
          indexedSessions: 2,
          invocationSessions: 1,
          invocationCalls: 3,
          missingInvocationSessions: 0,
          mcpCalls: 1,
          mcpToolSessions: 1,
          mcpToolCalls: 1,
          tokenSessions: 1,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheCreationTokens: 10,
          promptTokens: 410,
          cacheMissTokens: 110,
          compactionSessions: 1,
          compactionCount: 1,
          providers: [
            {
              provider: "cursor",
              totalSessions: 2,
              indexedSessions: 2,
              invocationSessions: 1,
              invocationCalls: 3,
              missingInvocationSessions: 0,
              mcpSessions: 1,
              mcpCalls: 1,
              mcpToolSessions: 1,
              mcpToolCalls: 1,
              tokenSessions: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 300,
              cacheCreationTokens: 10,
              promptTokens: 410,
              cacheMissTokens: 110,
              compactionSessions: 1,
              compactionCount: 1,
              metrics: {
                invocations: { availableSessions: 2, totalSessions: 2, quality: "exact" },
                mcpTools: { availableSessions: 1, totalSessions: 1, quality: "exact" },
                tokens: { availableSessions: 1, totalSessions: 2, quality: "partial" },
                cache: { availableSessions: 1, totalSessions: 2, quality: "partial" },
                compactions: { availableSessions: 1, totalSessions: 2, quality: "partial" },
              },
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain("uncached / miss");
    expect(screen.getByText("110")).toBeDefined();
    expect(screen.getAllByText("partial").length).toBeGreaterThan(0);
    expect(screen.getByText("Cursor")).toBeDefined();
  });
});

describe("TopProjectsList", () => {
  it("keeps projects with the same basename distinguishable", () => {
    render(
      <TopProjectsList
        projects={[
          {
            project: "~/git/roblox/ros-2",
            sessions: 2,
            cost: 1,
            prompts: 2,
            durationMs: 1_000,
            edits: 1,
          },
          {
            project: "~/Code/ros-2",
            sessions: 1,
            cost: 0,
            prompts: 1,
            durationMs: 500,
            edits: 0,
          },
        ]}
      />,
    );

    expect(screen.getByText("~/git/roblox/ros-2")).toBeDefined();
    expect(screen.getByText("~/Code/ros-2")).toBeDefined();
  });
});
