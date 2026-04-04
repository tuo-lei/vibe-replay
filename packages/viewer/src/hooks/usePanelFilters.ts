import { useEffect, useState } from "react";
import { navigateTo } from "../components/dashboard-utils";

export const ALL_PROJECTS = "__all__";

function getProjectFromUrl(): string {
  return new URLSearchParams(window.location.search).get("project") || ALL_PROJECTS;
}
function getFilterFromUrl(): string {
  return new URLSearchParams(window.location.search).get("q") || "";
}
function getShowArchivedFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get("archived") === "true";
}

/** Shared URL-synced filter state used by SessionsPanel and ReplaysPanel. */
export function usePanelFilters() {
  const [selectedProject, setSelectedProject] = useState(getProjectFromUrl);
  const [filter, setFilter] = useState(getFilterFromUrl);
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl);

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleProjectChange = (project: string) => {
    setSelectedProject(project);
    navigateTo({ project: project === ALL_PROJECTS ? null : project });
  };

  const handleFilterChange = (val: string) => {
    setFilter(val);
    navigateTo({ q: val || null }, { replace: true });
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    navigateTo({ archived: next ? "true" : null });
  };

  return {
    selectedProject,
    filter,
    showArchived,
    handleProjectChange,
    handleFilterChange,
    handleToggleArchived,
  };
}
