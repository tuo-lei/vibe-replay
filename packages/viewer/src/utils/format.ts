/**
 * Shared display-formatting helpers used across panels.
 */

/** Last path segment of a project path (e.g. "/Users/x/Code/foo" → "foo"). */
export function shortName(project: string): string {
  return project.split("/").pop() || project;
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
