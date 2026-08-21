export const NO_REPO_FILTER = "__no_repo__";

export interface DashboardFilterItem {
  provider: string;
  gitRepo?: string;
  project: string;
  tools?: readonly string[];
  mcpServers?: readonly string[];
  mcpTools?: readonly string[];
  skills?: readonly string[];
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

function matchesMultiValueFacet(
  values: readonly string[] | undefined,
  selectedValues: ReadonlySet<string>,
): boolean {
  return selectedValues.size === 0 || values?.some((value) => selectedValues.has(value)) === true;
}

export function matchesUsageFacets(
  item: Pick<DashboardFilterItem, "tools" | "mcpServers" | "mcpTools" | "skills">,
  selectedTools: ReadonlySet<string>,
  selectedMcpServers: ReadonlySet<string>,
  selectedMcpTools: ReadonlySet<string>,
  selectedSkills: ReadonlySet<string>,
): boolean {
  return (
    matchesMultiValueFacet(item.tools, selectedTools) &&
    matchesMultiValueFacet(item.mcpServers, selectedMcpServers) &&
    matchesMultiValueFacet(item.mcpTools, selectedMcpTools) &&
    matchesMultiValueFacet(item.skills, selectedSkills)
  );
}

export function applyDashboardFacetFilters<T extends DashboardFilterItem>(
  items: T[],
  options: {
    selectedProviders: readonly string[];
    selectedRepos: readonly string[];
    selectedProjectKey: string;
    allProjectsKey: string;
    rollupProject: (project: string) => string;
    selectedTools?: readonly string[];
    selectedMcpServers?: readonly string[];
    selectedMcpTools?: readonly string[];
    selectedSkills?: readonly string[];
  },
): T[] {
  const selectedProviderSet = new Set(options.selectedProviders);
  const selectedRepoSet = new Set(options.selectedRepos);
  const selectedToolSet = new Set(options.selectedTools);
  const selectedMcpServerSet = new Set(options.selectedMcpServers);
  const selectedMcpToolSet = new Set(options.selectedMcpTools);
  const selectedSkillSet = new Set(options.selectedSkills);
  return items.filter(
    (item) =>
      matchesProviderFacet(item, selectedProviderSet) &&
      matchesRepoFacet(item, selectedRepoSet) &&
      matchesProjectFacet(
        item,
        options.selectedProjectKey,
        options.allProjectsKey,
        options.rollupProject,
      ) &&
      matchesUsageFacets(
        item,
        selectedToolSet,
        selectedMcpServerSet,
        selectedMcpToolSet,
        selectedSkillSet,
      ),
  );
}
