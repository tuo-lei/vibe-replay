import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Where Muse stores per-agent session transcripts:
 *   <agentsRoot>/<agentId>/sessions/<agentId>.jsonl
 *   <agentsRoot>/<agentId>/sessions/sessions.json   (runtime index, best-effort)
 *
 * The env var overrides the default (useful for tests and boxed runs).
 */
export function getMuseAgentsDirs(): string[] {
  const configured = process.env.MUSE_AGENTS_DIR?.trim();
  return [configured || join(homedir(), "agents")];
}

export function getMuseAgentsDir(): string {
  return getMuseAgentsDirs()[0];
}

export interface MuseSessionMeta {
  updatedAt?: string;
  model?: string;
  itemCount?: number;
  compactionCount?: number;
}

/**
 * Best-effort lookup of a session in the runtime's sessions.json index,
 * which lives in the same directory as the transcript. Never throws.
 */
export async function readMuseSessionMeta(
  sessionsDir: string,
  sessionId: string,
): Promise<MuseSessionMeta | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(sessionsDir, "sessions.json"), "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return undefined;
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.session_id !== sessionId) continue;
    const usage = candidate.context_window_usage as Record<string, unknown> | undefined;
    const meta: MuseSessionMeta = {};
    if (typeof candidate.updated_at === "string") meta.updatedAt = candidate.updated_at;
    if (typeof candidate.compaction_count === "number")
      meta.compactionCount = candidate.compaction_count;
    if (typeof candidate.item_count === "number") meta.itemCount = candidate.item_count;
    if (usage && typeof usage.model_id === "string") meta.model = usage.model_id;
    return meta;
  }
  return undefined;
}
