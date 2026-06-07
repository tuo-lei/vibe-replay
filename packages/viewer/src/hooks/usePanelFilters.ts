import { useEffect, useState } from "react";
import { navigateTo } from "../components/dashboard-utils";

export const ALL_PROJECTS = "__all__";

function getMultiFromUrl(param: string): string[] {
  const raw = new URLSearchParams(window.location.search).get(param);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => {
      try {
        return decodeURIComponent(v.trim());
      } catch {
        return v.trim();
      }
    })
    .filter(Boolean);
}

function multiParam(values: readonly string[]): string | null {
  return values.length > 0 ? values.map(encodeURIComponent).join(",") : null;
}

function getProjectFromUrl(): string {
  return new URLSearchParams(window.location.search).get("project") || ALL_PROJECTS;
}
function getFilterFromUrl(): string {
  return new URLSearchParams(window.location.search).get("q") || "";
}
function getShowArchivedFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get("archived") === "true";
}

function getProvidersFromUrl(): string[] {
  return getMultiFromUrl("provider");
}

function getReposFromUrl(): string[] {
  return getMultiFromUrl("repo");
}

function getReplayStatusesFromUrl(): string[] {
  return getMultiFromUrl("replay");
}

/** Shared URL-synced filter state used by SessionsPanel and ReplaysPanel. */
export function usePanelFilters() {
  const [selectedProject, setSelectedProject] = useState(getProjectFromUrl);
  const [filter, setFilter] = useState(getFilterFromUrl);
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl);
  const [selectedProviders, setSelectedProviders] = useState(getProvidersFromUrl);
  const [selectedRepos, setSelectedRepos] = useState(getReposFromUrl);
  const [selectedReplayStatuses, setSelectedReplayStatuses] = useState(getReplayStatusesFromUrl);

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
      setSelectedProviders(getProvidersFromUrl());
      setSelectedRepos(getReposFromUrl());
      setSelectedReplayStatuses(getReplayStatusesFromUrl());
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleProjectChange = (project: string) => {
    setSelectedProject(project);
    navigateTo({ project: project === ALL_PROJECTS ? null : project }, { notify: false });
  };

  const handleFilterChange = (val: string) => {
    setFilter(val);
    navigateTo({ q: val || null }, { replace: true });
  };

  const handleProviderSet = (providers: string[]) => {
    setSelectedProviders(providers);
    navigateTo({ provider: multiParam(providers) }, { notify: false });
  };

  const handleProviderToggle = (provider: string) => {
    const next = selectedProviders.includes(provider)
      ? selectedProviders.filter((p) => p !== provider)
      : [...selectedProviders, provider];
    handleProviderSet(next);
  };

  const handleRepoSet = (repos: string[]) => {
    setSelectedRepos(repos);
    navigateTo({ repo: multiParam(repos) }, { notify: false });
  };

  const handleRepoToggle = (repo: string) => {
    const next = selectedRepos.includes(repo)
      ? selectedRepos.filter((r) => r !== repo)
      : [...selectedRepos, repo];
    handleRepoSet(next);
  };

  const handleReplayStatusSet = (statuses: string[]) => {
    setSelectedReplayStatuses(statuses);
    navigateTo({ replay: multiParam(statuses) }, { notify: false });
  };

  const handleReplayStatusToggle = (status: string) => {
    const next = selectedReplayStatuses.includes(status)
      ? selectedReplayStatuses.filter((s) => s !== status)
      : [...selectedReplayStatuses, status];
    handleReplayStatusSet(next);
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    navigateTo({ archived: next ? "true" : null }, { notify: false });
  };

  const handleClearAllFilters = () => {
    // Archive visibility is treated as a display mode, not a content facet, so
    // Clear all only resets the explorer dimensions shown as active chips.
    setSelectedProject(ALL_PROJECTS);
    setFilter("");
    setSelectedProviders([]);
    setSelectedRepos([]);
    setSelectedReplayStatuses([]);
    navigateTo(
      { project: null, q: null, provider: null, repo: null, replay: null },
      { notify: false },
    );
  };

  return {
    selectedProject,
    filter,
    showArchived,
    selectedProviders,
    selectedRepos,
    selectedReplayStatuses,
    handleProjectChange,
    handleFilterChange,
    handleProviderSet,
    handleProviderToggle,
    handleRepoSet,
    handleRepoToggle,
    handleReplayStatusSet,
    handleReplayStatusToggle,
    handleToggleArchived,
    handleClearAllFilters,
  };
}
