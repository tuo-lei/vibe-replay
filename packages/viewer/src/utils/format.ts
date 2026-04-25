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
