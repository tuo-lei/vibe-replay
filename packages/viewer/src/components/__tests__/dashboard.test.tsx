// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_PROJECTS } from "../../hooks/usePanelFilters";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import Dashboard, { getSessionRangeTimestamp, shouldIncludeSessionForProject } from "../Dashboard";

beforeEach(() => {
  stubBrowserAPIs();
  // Dashboard fetches replay/source data on mount. Reject so it exercises its
  // error/empty handling instead of hitting the network — modelling each
  // endpoint's exact response shape is out of scope for a smoke test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard (smoke)", () => {
  it("renders its chrome (search + facets) without crashing", () => {
    render(<Dashboard />);
    // Static chrome rendered before data loads (mobile + desktop search boxes).
    expect(screen.getAllByPlaceholderText(/search/i).length).toBeGreaterThan(0);
    // Sidebar facet headers.
    expect(screen.getByText(/Provider/)).toBeTruthy();
    expect(screen.getByText(/Project path/)).toBeTruthy();
  });

  it("kicks off a data fetch on mount", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // (The post-fetch view depends on each endpoint's exact response shape, so
    // asserting it is out of scope for this smoke test — the mount + load path
    // not throwing is the signal.)
  });
});

describe("session range timestamps", () => {
  it("prefers the scanned start time over discovery activity time", () => {
    const source = {
      provider: "cursor",
      slug: "session",
      project: "~/code/project",
      timestamp: "2026-08-23T12:00:00Z",
      fileSize: 0,
      lineCount: 0,
      firstPrompt: "",
      filePaths: [],
      existingReplay: null,
    };

    expect(
      getSessionRangeTimestamp(source, {
        startTime: "2026-08-01T12:00:00Z",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 0,
        toolCallCount: 0,
      }),
    ).toBe("2026-08-01T12:00:00Z");
    expect(getSessionRangeTimestamp(source)).toBe("2026-08-23T12:00:00Z");
  });
});

describe("automated project visibility", () => {
  const source = {
    project: "~/cursor-sdk/repos/cursor-coworktrees/worktrees/github-pr-review-Roblox-ros-13473",
    projectIdentity: {
      key: "cursor-sdk:github-pr-review:Roblox/ros",
      kind: "cursor-sdk-automation" as const,
      isAutomated: true,
    },
  };

  it("keeps automated workspaces hidden until their project is selected", () => {
    expect(shouldIncludeSessionForProject(source, ALL_PROJECTS, false)).toBe(false);
    expect(
      shouldIncludeSessionForProject(source, "cursor-sdk:github-pr-review:Roblox/ros", false),
    ).toBe(true);
    expect(shouldIncludeSessionForProject(source, "~/other-project", false)).toBe(false);
  });

  it("shows all automated workspaces when the explicit toggle is enabled", () => {
    expect(shouldIncludeSessionForProject(source, ALL_PROJECTS, true)).toBe(true);
  });
});
