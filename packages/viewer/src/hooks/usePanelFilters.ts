import { useEffect, useRef, useState } from "react";
import {
  navigateTo,
  normalizeMcpServerName,
  normalizeMcpToolName,
} from "../components/dashboard-utils";
import type { InsightsRange } from "../engine/insights-rollup";

export const ALL_PROJECTS = "__all__";
export const INSIGHTS_RANGE_PARAM = "insightsRange";

const INSIGHTS_RANGES = new Set<InsightsRange>(["7d", "30d", "90d", "all"]);

export function getMultiFromUrl(param: string): string[] {
  return new URLSearchParams(window.location.search)
    .getAll(param)
    .filter((value) => value.length > 0);
}

function multiParam(values: readonly string[]): readonly string[] | null {
  return values.length > 0 ? [...values] : null;
}

function getProjectFromUrl(): string {
  return new URLSearchParams(window.location.search).get("project") || ALL_PROJECTS;
}
function getTargetIdFromUrl(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("targetId");
  return value || undefined;
}
function getFilterFromUrl(): string {
  return new URLSearchParams(window.location.search).get("q") || "";
}
function getShowArchivedFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get("archived") === "true";
}
function getShowAgentRunsFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get("agentRuns") === "true";
}
export function getInsightsRangeFromUrl(): InsightsRange {
  const value = new URLSearchParams(window.location.search).get(INSIGHTS_RANGE_PARAM);
  return INSIGHTS_RANGES.has(value as InsightsRange) ? (value as InsightsRange) : "all";
}

function getProvidersFromUrl(): string[] {
  return getMultiFromUrl("provider");
}

function getReposFromUrl(): string[] {
  return getMultiFromUrl("repo");
}

function getToolsFromUrl(): string[] {
  return getMultiFromUrl("tool");
}

function getMcpServersFromUrl(): string[] {
  return getMultiFromUrl("mcp").map(normalizeMcpServerName);
}

function getMcpToolsFromUrl(): string[] {
  return getMultiFromUrl("mcpTool").map(normalizeMcpToolName);
}

function getSkillsFromUrl(): string[] {
  return getMultiFromUrl("skill");
}

/** Shared URL-synced filter state used by SessionsPanel and ReplaysPanel. */
export function usePanelFilters() {
  const [selectedProject, setSelectedProject] = useState(getProjectFromUrl);
  const [selectedTargetId, setSelectedTargetId] = useState(getTargetIdFromUrl);
  const [filter, setFilter] = useState(getFilterFromUrl);
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl);
  const [showAgentRuns, setShowAgentRuns] = useState(getShowAgentRunsFromUrl);
  const [insightsRange, setInsightsRange] = useState(getInsightsRangeFromUrl);
  const [selectedProviders, setSelectedProviders] = useState(getProvidersFromUrl);
  const [selectedRepos, setSelectedRepos] = useState(getReposFromUrl);
  const [selectedTools, setSelectedTools] = useState(getToolsFromUrl);
  const [selectedMcpServers, setSelectedMcpServers] = useState(getMcpServersFromUrl);
  const [selectedMcpTools, setSelectedMcpTools] = useState(getMcpToolsFromUrl);
  const [selectedSkills, setSelectedSkills] = useState(getSkillsFromUrl);
  const selectedProvidersRef = useRef(selectedProviders);
  const selectedReposRef = useRef(selectedRepos);
  const selectedToolsRef = useRef(selectedTools);
  const selectedMcpServersRef = useRef(selectedMcpServers);
  const selectedMcpToolsRef = useRef(selectedMcpTools);
  const selectedSkillsRef = useRef(selectedSkills);

  useEffect(() => {
    selectedProvidersRef.current = selectedProviders;
  }, [selectedProviders]);

  useEffect(() => {
    selectedReposRef.current = selectedRepos;
  }, [selectedRepos]);

  useEffect(() => {
    selectedToolsRef.current = selectedTools;
  }, [selectedTools]);

  useEffect(() => {
    selectedMcpServersRef.current = selectedMcpServers;
  }, [selectedMcpServers]);

  useEffect(() => {
    selectedMcpToolsRef.current = selectedMcpTools;
  }, [selectedMcpTools]);

  useEffect(() => {
    selectedSkillsRef.current = selectedSkills;
  }, [selectedSkills]);

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setSelectedTargetId(getTargetIdFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
      setShowAgentRuns(getShowAgentRunsFromUrl());
      setInsightsRange(getInsightsRangeFromUrl());
      const providers = getProvidersFromUrl();
      const repos = getReposFromUrl();
      const tools = getToolsFromUrl();
      const mcpServers = getMcpServersFromUrl();
      const mcpTools = getMcpToolsFromUrl();
      const skills = getSkillsFromUrl();
      selectedProvidersRef.current = providers;
      selectedReposRef.current = repos;
      selectedToolsRef.current = tools;
      selectedMcpServersRef.current = mcpServers;
      selectedMcpToolsRef.current = mcpTools;
      selectedSkillsRef.current = skills;
      setSelectedProviders(providers);
      setSelectedRepos(repos);
      setSelectedTools(tools);
      setSelectedMcpServers(mcpServers);
      setSelectedMcpTools(mcpTools);
      setSelectedSkills(skills);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleProjectChange = (project: string, targetId?: string) => {
    setSelectedProject(project);
    setSelectedTargetId(project === ALL_PROJECTS ? undefined : targetId);
    navigateTo(
      {
        project: project === ALL_PROJECTS ? null : project,
        targetId: project === ALL_PROJECTS || !targetId ? null : targetId,
      },
      { notify: false },
    );
  };

  const handleFilterChange = (val: string) => {
    setFilter(val);
    navigateTo({ q: val || null }, { replace: true });
  };

  const handleProviderSet = (providers: string[]) => {
    selectedProvidersRef.current = providers;
    setSelectedProviders(providers);
    navigateTo({ provider: multiParam(providers) }, { notify: false });
  };

  const handleProviderToggle = (provider: string) => {
    const prev = selectedProvidersRef.current;
    const next = prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider];
    handleProviderSet(next);
  };

  const handleRepoSet = (repos: string[]) => {
    selectedReposRef.current = repos;
    setSelectedRepos(repos);
    navigateTo({ repo: multiParam(repos) }, { notify: false });
  };

  const handleRepoToggle = (repo: string) => {
    const prev = selectedReposRef.current;
    const next = prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo];
    handleRepoSet(next);
  };

  const handleToolToggle = (tool: string) => {
    const prev = selectedToolsRef.current;
    const next = prev.includes(tool) ? prev.filter((value) => value !== tool) : [...prev, tool];
    selectedToolsRef.current = next;
    setSelectedTools(next);
    navigateTo({ tool: multiParam(next) }, { notify: false });
  };

  const handleMcpServerToggle = (server: string) => {
    const prev = selectedMcpServersRef.current;
    const next = prev.includes(server)
      ? prev.filter((value) => value !== server)
      : [...prev, server];
    selectedMcpServersRef.current = next;
    setSelectedMcpServers(next);
    navigateTo({ mcp: multiParam(next) }, { notify: false });
  };

  const handleMcpToolToggle = (tool: string) => {
    const prev = selectedMcpToolsRef.current;
    const next = prev.includes(tool) ? prev.filter((value) => value !== tool) : [...prev, tool];
    selectedMcpToolsRef.current = next;
    setSelectedMcpTools(next);
    navigateTo({ mcpTool: multiParam(next) }, { notify: false });
  };

  const handleSkillToggle = (skill: string) => {
    const prev = selectedSkillsRef.current;
    const next = prev.includes(skill) ? prev.filter((value) => value !== skill) : [...prev, skill];
    selectedSkillsRef.current = next;
    setSelectedSkills(next);
    navigateTo({ skill: multiParam(next) }, { notify: false });
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    navigateTo({ archived: next ? "true" : null }, { notify: false });
  };

  const handleToggleAgentRuns = () => {
    const next = !showAgentRuns;
    setShowAgentRuns(next);
    navigateTo({ agentRuns: next ? "true" : null }, { notify: false });
  };

  const handleClearInsightsRange = () => {
    setInsightsRange("all");
    navigateTo({ [INSIGHTS_RANGE_PARAM]: null }, { notify: false });
  };

  const handleClearAllFilters = () => {
    // Archive and agent-run visibility are display modes, not content facets,
    // so Clear all only resets the explorer dimensions shown as active chips.
    setSelectedProject(ALL_PROJECTS);
    setSelectedTargetId(undefined);
    setFilter("");
    selectedProvidersRef.current = [];
    selectedReposRef.current = [];
    selectedToolsRef.current = [];
    selectedMcpServersRef.current = [];
    selectedMcpToolsRef.current = [];
    selectedSkillsRef.current = [];
    setSelectedProviders([]);
    setSelectedRepos([]);
    setSelectedTools([]);
    setSelectedMcpServers([]);
    setSelectedMcpTools([]);
    setSelectedSkills([]);
    setInsightsRange("all");
    navigateTo(
      {
        project: null,
        targetId: null,
        q: null,
        provider: null,
        repo: null,
        tool: null,
        mcp: null,
        mcpTool: null,
        skill: null,
        [INSIGHTS_RANGE_PARAM]: null,
        replay: null,
      },
      { notify: false },
    );
  };

  return {
    selectedProject,
    selectedTargetId,
    filter,
    showArchived,
    showAgentRuns,
    insightsRange,
    selectedProviders,
    selectedRepos,
    selectedTools,
    selectedMcpServers,
    selectedMcpTools,
    selectedSkills,
    handleProjectChange,
    handleFilterChange,
    handleProviderSet,
    handleProviderToggle,
    handleRepoSet,
    handleRepoToggle,
    handleToolToggle,
    handleMcpServerToggle,
    handleMcpToolToggle,
    handleSkillToggle,
    handleToggleArchived,
    handleToggleAgentRuns,
    handleClearInsightsRange,
    handleClearAllFilters,
  };
}
