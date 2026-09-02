// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_PROJECTS } from "../../hooks/usePanelFilters";
import type { SessionUsageSummary } from "../../types";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import Dashboard, {
  buildSessionScanIndex,
  contextFootprintSummary,
  findSessionScanData,
  getSessionRangeTimestamp,
  type SessionScanData,
  shouldIncludeSessionForFacets,
  shouldIncludeSessionForProject,
  usageFacetValues,
} from "../Dashboard";
import { remoteSourceFailureLabels } from "../dashboard-utils";
import { shouldStartBackgroundScan } from "../InsightsPanel";

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
  window.__VIBE_REPLAY_EDITOR__ = false;
  window.history.replaceState({}, "", "/");
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
  it("keeps all dashboard tabs reachable through the mobile navigation", async () => {
    window.__VIBE_REPLAY_EDITOR__ = true;
    render(<Dashboard headerLeft={<span>Brand</span>} headerRight={<span>Actions</span>} />);

    expect(screen.queryByRole("navigation", { name: "Dashboard navigation" })).toBeNull();
    screen.getByRole("button", { name: "Open dashboard navigation" }).click();

    const mobileNavigation = await waitFor(() =>
      screen.getByRole("navigation", { name: "Dashboard navigation" }),
    );
    expect(within(mobileNavigation).getByRole("button", { name: "Projects" })).toBeTruthy();
    expect(within(mobileNavigation).getByRole("button", { name: "Insights" })).toBeTruthy();
    expect(within(mobileNavigation).getByRole("button", { name: "Settings" })).toBeTruthy();

    within(mobileNavigation).getByRole("button", { name: "Settings" }).click();
    expect(window.location.search).toContain("tab=settings");
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Dashboard navigation" })).toBeNull(),
    );
  });
});

describe("contextFootprintSummary", () => {
  it("falls back to component tokens when the provider total is absent", () => {
    expect(
      contextFootprintSummary({
        source: "cursor-prompt-token-breakdown",
        scope: "latest-snapshot",
        contextLimit: 100_000,
        components: [
          { id: "system-prompt", estimatedTokens: 3_000 },
          { id: "conversation", estimatedTokens: 17_000 },
        ],
      }),
    ).toBe("20K / 100K tokens");
  });
});

describe("remote source diagnostics", () => {
  it("uses the configured remote label instead of exposing its internal id", () => {
    expect(
      remoteSourceFailureLabels({
        failedProviders: ["ssh:remote-devspace"],
        remoteSources: [{ id: "remote-devspace", label: "ROS devspace" }],
      }),
    ).toEqual(["ROS devspace"]);
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

  it("keeps a selected automated project visible while deriving facets", () => {
    expect(
      shouldIncludeSessionForFacets(source, "cursor-sdk:github-pr-review:Roblox/ros", false),
    ).toBe(true);
    expect(shouldIncludeSessionForFacets(source, ALL_PROJECTS, false)).toBe(false);
  });
});

describe("session scan result matching", () => {
  it("prefers provider-scoped session IDs and only falls back to unique slugs", () => {
    const results: SessionScanData[] = [
      {
        provider: "cursor",
        sessionId: "cursor-first",
        slug: "agent-a9",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 0,
        toolCallCount: 0,
        usageSummary: {
          tools: { Bash: 1 },
          mcpServers: {},
          mcpTools: {},
          skills: {},
          successCount: 1,
          errorCount: 0,
          totalDurationMs: 0,
          durationCount: 0,
        },
      },
      {
        provider: "cursor",
        sessionId: "cursor-second",
        slug: "agent-a9",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 0,
        toolCallCount: 0,
        usageSummary: {
          tools: { Edit: 1 },
          mcpServers: {},
          mcpTools: {},
          skills: {},
          successCount: 1,
          errorCount: 0,
          totalDurationMs: 0,
          durationCount: 0,
        },
      },
    ];
    const index = buildSessionScanIndex(results);

    expect(
      findSessionScanData(
        { provider: "cursor", sessionId: "cursor-second", slug: "agent-a9" },
        index,
      )?.usageSummary?.tools,
    ).toEqual({ Edit: 1 });
    expect(findSessionScanData({ provider: "cursor", slug: "agent-a9" }, index)).toBeUndefined();
  });

  it("uses a provider-scoped slug when it is unambiguous", () => {
    const result = {
      provider: "cursor",
      sessionId: "cursor-only",
      slug: "unique-slug",
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 0,
      editCount: 0,
      filesModified: [],
      promptCount: 0,
      toolCallCount: 0,
    };
    const index = buildSessionScanIndex([result]);

    expect(findSessionScanData({ provider: "cursor", slug: "unique-slug" }, index)).toBe(result);
  });
});

describe("usage index recovery", () => {
  it("resumes a fresh persisted snapshot when Cursor usage is incomplete", () => {
    const cachedAt = new Date().toISOString();

    expect(
      shouldStartBackgroundScan({
        running: false,
        hasSnapshot: true,
        cachedAt,
        usageIndexPending: 3,
      }),
    ).toBe(true);
    expect(
      shouldStartBackgroundScan({
        running: false,
        hasSnapshot: true,
        cachedAt,
        usageIndexPending: 0,
      }),
    ).toBe(false);
  });

  it("keeps provider-discovered MCP servers and skills visible before rich usage arrives", () => {
    expect(
      usageFacetValues({
        provider: "cursor",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 0,
        toolCallCount: 0,
        mcpServersUsed: ["sourcegraph"],
        skillsUsed: ["review"],
      }),
    ).toEqual({
      tools: [],
      mcpServers: ["sourcegraph"],
      mcpTools: [],
      skills: ["review"],
    });
  });
});

describe("Replays usage facets", () => {
  it("loads scan usage and filters replays by tool and MCP server", async () => {
    window.__VIBE_REPLAY_EDITOR__ = true;
    window.history.replaceState({}, "", "?tab=replays");
    const cachedAt = new Date().toISOString();
    const sessions = [
      {
        slug: "replay-one",
        sessionId: "cursor-one",
        title: "Bash replay",
        provider: "cursor",
        project: "~/project",
        startTime: cachedAt,
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 1 },
        hasAnnotations: false,
        annotationCount: 0,
      },
      {
        slug: "replay-two",
        sessionId: "cursor-two",
        title: "Edit replay",
        provider: "cursor",
        project: "~/project",
        startTime: cachedAt,
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 1 },
        hasAnnotations: false,
        annotationCount: 0,
      },
    ];
    const usage = (tool: string, server: string): SessionUsageSummary => ({
      tools: { [tool]: 1 },
      mcpServers: { [server]: 1 },
      mcpTools: { [`${server}/search`]: 1 },
      skills: {},
      successCount: 1,
      errorCount: 0,
      totalDurationMs: 0,
      durationCount: 0,
    });
    const scanResults = [
      {
        provider: "cursor",
        sessionId: "cursor-one",
        slug: "replay-one",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 1,
        toolCallCount: 1,
        usageSummary: usage("Bash", "linear"),
      },
      {
        provider: "cursor",
        sessionId: "cursor-two",
        slug: "replay-two",
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        editCount: 0,
        filesModified: [],
        promptCount: 1,
        toolCallCount: 1,
        usageSummary: usage("Edit", "github"),
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/scan/status")) {
          return {
            ok: true,
            json: async () => ({
              running: false,
              scanned: 2,
              total: 2,
              resultCount: 2,
              hasSnapshot: true,
              hasCachedResults: true,
              cachedResultCount: 2,
              cachedAt,
              hasInsights: false,
            }),
          };
        }
        if (url.endsWith("/api/archived")) {
          return { ok: true, json: async () => ({ slugs: [] }) };
        }
        if (url.endsWith("/api/sessions/cached")) {
          return { ok: true, json: async () => ({ sessions, cachedAt }) };
        }
        if (url.endsWith("/api/scan/results")) {
          return { ok: true, json: async () => ({ results: scanResults, finishedAt: cachedAt }) };
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText("Bash")).toBeTruthy());
    expect(screen.getByText("MCP server")).toBeTruthy();
    expect(screen.getByText("Bash replay")).toBeTruthy();
    expect(screen.getByText("Edit replay")).toBeTruthy();

    screen.getByRole("button", { name: /Bash 1/ }).click();
    await waitFor(() => {
      expect(screen.getByText("Bash replay")).toBeTruthy();
      expect(screen.queryByText("Edit replay")).toBeNull();
    });

    screen.getByRole("button", { name: /Bash 1/ }).click();
    screen.getByRole("button", { name: /linear 1/ }).click();
    await waitFor(() => {
      expect(screen.getByText("Bash replay")).toBeTruthy();
      expect(screen.queryByText("Edit replay")).toBeNull();
    });
  });
});
