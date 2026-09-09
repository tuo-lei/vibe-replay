const SAND_SUBAGENT_ID_RE =
  /sand-subagent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const ID_KEYS = [
  "sessionId",
  "session_id",
  "agentId",
  "agent_id",
  "subagentId",
  "subagent_id",
  "id",
];

/** Pull a `sand-subagent-<uuid>` id out of task input/result payloads. */
export function findSandSubagentId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === "string") {
    const match = SAND_SUBAGENT_ID_RE.exec(value);
    return match?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSandSubagentId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ID_KEYS) {
    if (!(key in obj)) continue;
    const found = findSandSubagentId(obj[key], depth + 1);
    if (found) return found;
  }
  for (const item of Object.values(obj)) {
    const found = findSandSubagentId(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}
