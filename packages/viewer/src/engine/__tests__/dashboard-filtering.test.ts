import { describe, expect, it } from "vitest";
import {
  applyDashboardFacetFilters,
  matchesProjectFacet,
  mergeCompactionCounts,
} from "../dashboard-filtering";

const ALL_PROJECTS = "__all__";
const identityRollup = (project: string) => project;

const sessions = [
  { provider: "cursor", gitRepo: "tuo-lei/vibe-replay", project: "/repo/vibe", slug: "cursor-1" },
  { provider: "cursor", gitRepo: "Roblox/ros", project: "/repo/ros", slug: "cursor-ros" },
  { provider: "pi", gitRepo: "Roblox/ros", project: "/repo/ros", slug: "pi-ros" },
  { provider: "pi", gitRepo: undefined, project: "/repo/pi", slug: "pi-no-repo" },
  { provider: "claude-code", gitRepo: "Roblox/ros", project: "/repo/ros", slug: "claude-ros" },
  {
    provider: "claude-code",
    gitRepo: "Roblox/declawd",
    project: "/repo/declawd",
    slug: "claude-declawd",
  },
];

describe("dashboard facet filtering", () => {
  it("does not include Cursor sessions when Pi and Claude Code are selected", () => {
    const filtered = applyDashboardFacetFilters(sessions, {
      selectedProviders: ["pi", "claude-code"],
      selectedRepos: [],
      selectedProjectKey: ALL_PROJECTS,
      allProjectsKey: ALL_PROJECTS,
      rollupProject: identityRollup,
    });

    expect(filtered.map((session) => session.provider)).toEqual([
      "pi",
      "pi",
      "claude-code",
      "claude-code",
    ]);
  });

  it("applies provider and repo filters together", () => {
    const filtered = applyDashboardFacetFilters(sessions, {
      selectedProviders: ["pi", "claude-code"],
      selectedRepos: ["Roblox/ros"],
      selectedProjectKey: ALL_PROJECTS,
      allProjectsKey: ALL_PROJECTS,
      rollupProject: identityRollup,
    });

    expect(filtered.map((session) => session.slug)).toEqual(["pi-ros", "claude-ros"]);
  });

  it("combines tool, MCP server, and skill facets", () => {
    const usageSessions = [
      {
        ...sessions[0],
        tools: ["Read", "CallMcpTool"],
        mcpServers: ["user-github"],
        mcpTools: ["user-github/get_pull_request"],
        skills: ["replay"],
      },
      {
        ...sessions[1],
        tools: ["Read", "Shell"],
        mcpServers: [],
        mcpTools: [],
        skills: ["review"],
      },
    ];
    const filtered = applyDashboardFacetFilters(usageSessions, {
      selectedProviders: [],
      selectedRepos: [],
      selectedProjectKey: ALL_PROJECTS,
      allProjectsKey: ALL_PROJECTS,
      rollupProject: identityRollup,
      selectedTools: ["Read"],
      selectedMcpServers: ["user-github"],
      selectedMcpTools: ["user-github/get_pull_request"],
      selectedSkills: ["replay"],
    });

    expect(filtered.map((session) => session.slug)).toEqual(["cursor-1"]);
  });

  it("filters to sessions with indexed compactions", () => {
    const filtered = applyDashboardFacetFilters(
      [
        { ...sessions[0], compactionCount: 2 },
        { ...sessions[1], compactionCount: 0 },
        { ...sessions[2], compactionCount: undefined },
      ],
      {
        selectedProviders: [],
        selectedRepos: [],
        selectedProjectKey: ALL_PROJECTS,
        allProjectsKey: ALL_PROJECTS,
        rollupProject: identityRollup,
        compactionsOnly: true,
      },
    );

    expect(filtered.map((session) => session.slug)).toEqual(["cursor-1"]);
  });

  it("keeps newer discovery compactions when a cached scan still reports zero", () => {
    expect(mergeCompactionCounts(0, 2)).toBe(2);
    expect(mergeCompactionCounts(3, 2)).toBe(3);
    expect(mergeCompactionCounts(undefined, undefined)).toBe(0);
  });

  it("matches both canonical projects and explicitly shown run workspaces", () => {
    const parent = "~/code/example";
    const runWorkspace = `${parent}/run-abcdef123456`;
    const rollup = (project: string) => (project === runWorkspace ? parent : project);

    expect(matchesProjectFacet({ project: parent }, parent, ALL_PROJECTS, rollup)).toBe(true);
    expect(matchesProjectFacet({ project: runWorkspace }, parent, ALL_PROJECTS, rollup)).toBe(true);
    expect(matchesProjectFacet({ project: runWorkspace }, runWorkspace, ALL_PROJECTS, rollup)).toBe(
      true,
    );
    expect(matchesProjectFacet({ project: parent }, runWorkspace, ALL_PROJECTS, rollup)).toBe(
      false,
    );
  });

  it("matches a session through its canonical project identity", () => {
    const identity = {
      key: "cursor-sdk:github-pr-review:Roblox/ros",
      kind: "cursor-sdk-automation" as const,
      isAutomated: true,
      displayName: "Automated · Roblox/ros · GitHub PR review",
    };

    expect(
      matchesProjectFacet(
        {
          project: "~/cursor-sdk/worktrees/github_pr_review-Roblox-ros-13473",
          projectIdentity: identity,
        },
        identity.key,
        ALL_PROJECTS,
        identityRollup,
      ),
    ).toBe(true);
  });

  it("keeps a selected project scoped to its location", () => {
    const local = {
      provider: "codex",
      project: "/repo/shared",
      slug: "local",
      location: undefined,
    };
    const remoteA = {
      ...local,
      slug: "remote-a",
      location: { kind: "ssh" as const, id: "remote-a", label: "Remote A" },
    };
    const remoteB = {
      ...local,
      slug: "remote-b",
      location: { kind: "ssh" as const, id: "remote-b", label: "Remote B" },
    };

    expect(
      applyDashboardFacetFilters([local, remoteA, remoteB], {
        selectedProviders: [],
        selectedRepos: [],
        selectedProjectKey: "/repo/shared",
        allProjectsKey: ALL_PROJECTS,
        rollupProject: identityRollup,
        selectedLocation: remoteA.location,
      }).map((session) => session.slug),
    ).toEqual(["remote-a"]);
    expect(matchesProjectFacet(local, "/repo/shared", ALL_PROJECTS, identityRollup, "local")).toBe(
      true,
    );
    expect(
      matchesProjectFacet(remoteA, "/repo/shared", ALL_PROJECTS, identityRollup, "local"),
    ).toBe(false);
  });
});
