import { useEffect, useRef, useState } from "react";
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

/** Shared URL-synced filter state used by SessionsPanel and ReplaysPanel. */
export function usePanelFilters() {
  const [selectedProject, setSelectedProject] = useState(getProjectFromUrl);
  const [filter, setFilter] = useState(getFilterFromUrl);
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl);
  const [selectedProviders, setSelectedProviders] = useState(getProvidersFromUrl);
  const [selectedRepos, setSelectedRepos] = useState(getReposFromUrl);
  const selectedProvidersRef = useRef(selectedProviders);
  const selectedReposRef = useRef(selectedRepos);

  useEffect(() => {
    selectedProvidersRef.current = selectedProviders;
  }, [selectedProviders]);

  useEffect(() => {
    selectedReposRef.current = selectedRepos;
  }, [selectedRepos]);

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
      const providers = getProvidersFromUrl();
      const repos = getReposFromUrl();
      selectedProvidersRef.current = providers;
      selectedReposRef.current = repos;
      setSelectedProviders(providers);
      setSelectedRepos(repos);
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
    selectedProvidersRef.current = [];
    selectedReposRef.current = [];
    setSelectedProviders([]);
    setSelectedRepos([]);
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
    handleProjectChange,
    handleFilterChange,
    handleProviderSet,
    handleProviderToggle,
    handleRepoSet,
    handleRepoToggle,
    handleToggleArchived,
    handleClearAllFilters,
  };
}
