import { useMemo } from "react";
import type { RelaySessionSummary } from "./protocol";
import {
  ActiveFilterChip,
  ActiveFilterChipRow,
  SearchFilterInput,
} from "../components/SessionFilters";
import { providerDisplayName } from "../components/dashboard-utils";
import { shortName } from "../utils/format";

/**
 * Compact session-list filter bar for the E2E live viewer.
 *
 * Mobile-first take on the local dashboard's facet sidebar: provider
 * multi-select chips, a project dropdown, a list text filter, and a sort
 * toggle. The actual matching reuses the dashboard's filter engine
 * (`engine/dashboard-filtering.ts`) — see LiveApp — so filter behavior
 * cannot drift between the two surfaces; only this presentation is
 * live-specific.
 */

export const ALL_PROJECTS = "__all__";

export interface LiveFilterState {
  text: string;
  providers: string[];
  project: string;
  sortNewest: boolean;
}

export const EMPTY_FILTERS: LiveFilterState = {
  text: "",
  providers: [],
  project: ALL_PROJECTS,
  sortNewest: true,
};

export function hasActiveFilters(f: LiveFilterState): boolean {
  return f.text.trim() !== "" || f.providers.length > 0 || f.project !== ALL_PROJECTS;
}

function countBy<T>(items: T[], key: (t: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function SessionFilterBar({
  sessions,
  filters,
  onChange,
}: {
  sessions: RelaySessionSummary[];
  filters: LiveFilterState;
  onChange: (f: LiveFilterState) => void;
}) {
  const providerEntries = useMemo(() => countBy(sessions, (s) => s.provider), [sessions]);
  const projectEntries = useMemo(() => countBy(sessions, (s) => s.project), [sessions]);

  const toggleProvider = (p: string) =>
    onChange({
      ...filters,
      providers: filters.providers.includes(p)
        ? filters.providers.filter((x) => x !== p)
        : [...filters.providers, p],
    });

  const active = hasActiveFilters(filters);
  const clearAll = () => onChange({ ...EMPTY_FILTERS, sortNewest: filters.sortNewest });

  return (
    <div className="mb-3 space-y-2">
      {/* Provider multi-select chips */}
      {providerEntries.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {providerEntries.map(([provider, count]) => {
            const selected = filters.providers.includes(provider);
            return (
              <button
                key={provider}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleProvider(provider)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                  selected
                    ? "border-terminal-green bg-terminal-green-subtle text-terminal-green"
                    : "border-terminal-border-subtle bg-terminal-surface text-terminal-dim hover:border-terminal-border hover:text-terminal-text"
                }`}
              >
                <span className="text-xs font-medium">{providerDisplayName(provider)}</span>
                <span
                  className={`tabular-nums text-[10px] font-mono ${selected ? "text-terminal-green" : "text-terminal-dimmer"}`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Project select + sort toggle + text filter */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.project}
          onChange={(e) => onChange({ ...filters, project: e.target.value })}
          aria-label="Filter by project"
          className="min-w-0 max-w-[180px] truncate rounded-lg bg-terminal-surface px-2.5 py-1.5 text-xs text-terminal-text ring-1 ring-terminal-border-subtle focus:outline-none focus:ring-terminal-green/40"
        >
          <option value={ALL_PROJECTS}>All projects</option>
          {projectEntries.map(([project, count]) => (
            <option key={project} value={project}>
              {shortName(project)} ({count})
            </option>
          ))}
        </select>
        <SearchFilterInput
          value={filters.text}
          onChange={(text) => onChange({ ...filters, text })}
          placeholder="Filter list…"
          ariaLabel="Filter sessions by text"
        />
        <button
          type="button"
          onClick={() => onChange({ ...filters, sortNewest: !filters.sortNewest })}
          title={filters.sortNewest ? "Newest first" : "Oldest first"}
          className="rounded-lg bg-terminal-surface px-2.5 py-1.5 text-xs text-terminal-dim ring-1 ring-terminal-border-subtle transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text"
        >
          {filters.sortNewest ? "↓ Newest" : "↑ Oldest"}
        </button>
      </div>

      {/* Active filter pills */}
      {active && (
        <ActiveFilterChipRow onClearAll={clearAll}>
          {filters.text.trim() !== "" && (
            <ActiveFilterChip
              label="Filter"
              value={filters.text.trim()}
              onRemove={() => onChange({ ...filters, text: "" })}
            />
          )}
          {filters.providers.map((p) => (
            <ActiveFilterChip
              key={p}
              label="Provider"
              value={providerDisplayName(p)}
              onRemove={() => toggleProvider(p)}
            />
          ))}
          {filters.project !== ALL_PROJECTS && (
            <ActiveFilterChip
              label="Project"
              value={shortName(filters.project)}
              onRemove={() => onChange({ ...filters, project: ALL_PROJECTS })}
            />
          )}
        </ActiveFilterChipRow>
      )}
    </div>
  );
}
