export const NO_REPO_FILTER = "__no_repo__";

export interface DashboardFilterItem {
  provider: string;
  gitRepo?: string;
  project: string;
}

export function repoFilterValue(s: Pick<DashboardFilterItem, "gitRepo">): string {
  return s.gitRepo || NO_REPO_FILTER;
}

export function matchesProviderFacet(
  s: Pick<DashboardFilterItem, "provider">,
  selectedProviders: ReadonlySet<string>,
): boolean {
  return selectedProviders.size === 0 || selectedProviders.has(s.provider);
}

export function matchesRepoFacet(
  s: Pick<DashboardFilterItem, "gitRepo">,
  selectedRepos: ReadonlySet<string>,
): boolean {
  return selectedRepos.size === 0 || selectedRepos.has(repoFilterValue(s));
}

export function matchesProjectFacet(
  s: Pick<DashboardFilterItem, "project">,
  selectedProjectKey: string,
  allProjectsKey: string,
  rollupProject: (project: string) => string,
): boolean {
  return selectedProjectKey === allProjectsKey || rollupProject(s.project) === selectedProjectKey;
}

export function applyDashboardFacetFilters<T extends DashboardFilterItem>(
  items: T[],
  options: {
    selectedProviders: readonly string[];
    selectedRepos: readonly string[];
    selectedProjectKey: string;
    allProjectsKey: string;
    rollupProject: (project: string) => string;
  },
): T[] {
  const selectedProviderSet = new Set(options.selectedProviders);
  const selectedRepoSet = new Set(options.selectedRepos);
  return items.filter(
    (item) =>
      matchesProviderFacet(item, selectedProviderSet) &&
      matchesRepoFacet(item, selectedRepoSet) &&
      matchesProjectFacet(
        item,
        options.selectedProjectKey,
        options.allProjectsKey,
        options.rollupProject,
      ),
  );
}
