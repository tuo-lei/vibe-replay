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
