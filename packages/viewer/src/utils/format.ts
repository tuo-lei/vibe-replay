/**
 * Shared display-formatting helpers used across panels.
 */

/** Normalize filesystem separators for consistent display across platforms. */
export function normalizePathForDisplay(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Return the meaningful path segments from either POSIX or Windows paths. */
export function pathSegments(path: string): string[] {
  return normalizePathForDisplay(path).split("/").filter(Boolean);
}

/** Last path segment of a project path (e.g. "/Users/x/Code/foo" → "foo"). */
export function shortName(project: string): string {
  return pathSegments(project).pop() || project;
}

/** Returns `singular` for count === 1, otherwise `pluralForm` (defaults to `${singular}s`). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Compact relative time. Pass `format: "long"` for ProjectsPanel-style suffixes
 * ("just now", "5m ago"), or omit for SessionRelationshipsView-style ("now", "5m").
 */
export function timeAgo(iso?: string, format: "short" | "long" = "short"): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (format === "long") {
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Compact duration ("45s", "3m 12s", "2h 5m"). Single canonical definition —
 * previously lived in StatsPanel.tsx; kept re-exported there so existing
 * imports keep working.
 */
export function formatDuration(ms?: number): string {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/**
 * Compact USD cost ("$1.23"). Single canonical definition — previously lived
 * in dashboard-utils.ts; kept re-exported there so existing imports keep
 * working.
 */
export function formatCost(cost?: number): string {
  if (!cost) return "";
  return `$${cost.toFixed(2)}`;
}

// For the single-session replay view (StatsPanel, SummaryView). The dashboard
// uses a separate, context-aware formatter in dashboard-utils.ts that takes
// hasSqlite into account — keep both in sync when adding new source types.
const DATA_SOURCE_LABELS: Record<string, string> = {
  sqlite: "SQLite (store.db)",
  "global-state": "SQLite (global state.vscdb)",
  jsonl: "JSONL transcript",
  "jsonl+tools": "JSONL + agent-tools",
};

export function formatReplaySourceLabel(source?: string): string {
  if (!source) return "unknown";
  return DATA_SOURCE_LABELS[source] || source;
}
