import { describe, expect, it } from "vitest";
import { applyDashboardFacetFilters } from "../dashboard-filtering";

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
});
