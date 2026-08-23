// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateToUsageSessions, UsageBarList } from "../InsightsPage";

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
    for (const key of [
      "project",
      "q",
      "provider",
      "repo",
      "tool",
      "mcp",
      "skill",
      "archived",
      "agentRuns",
      "replay",
    ]) {
      expect(params.get(key), `${key} should be cleared`).toBeNull();
    }
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

  it("round-trips facet names with URL-sensitive characters exactly once", () => {
    const value = "sourcegraph/search?query=foo bar&scope=100%";

    navigateToUsageSessions("mcpTool", value);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("mcpTool")).toBe(value);
  });
});
