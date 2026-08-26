/// <reference path="../sql-js.d.ts" />
import type { Database } from "sql.js";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { openOpencodeDb, opencodeDataDir, opencodeDbPath } from "./sqlite.js";

export const OPENCODE_PROVIDER = "opencode";

export interface OpencodeSessionRow {
  id: string;
  slug: string;
  title: string;
  directory: string;
  version: string;
  agent?: string;
  model?: string;
  time_created: number;
  time_updated: number;
  cost?: number;
  tokens_input?: number;
  tokens_output?: number;
  worktree?: string;
}

function rowValues(db: Database, sql: string, params: Record<string, any> = {}): any[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(Object.values(params));
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export async function discoverOpencodeSessions(): Promise<SessionInfo[]> {
  const opened = await openOpencodeDb();
  if (!opened) return [];
  const { db } = opened;
  try {
    return listSessionsFromDb(db);
  } finally {
    db.close();
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  try {
    return new Set(rowValues(db, `PRAGMA table_info(${table})`).map((row) => String(row.name)));
  } catch {
    return new Set<string>();
  }
}

/**
 * opencode reshapes its `session` table between releases — `agent`, `model`,
 * `cost`, and the token columns have all come and gone. Selecting them
 * unconditionally makes discovery throw `no such column`, so we project only
 * what the local schema actually has and let the optional fields stay
 * undefined.
 */
function buildSessionSelect(db: Database): string {
  const cols = tableColumns(db, "session");
  const optional = ["version", "agent", "model", "cost", "tokens_input", "tokens_output"];
  const selected = [
    "s.id",
    "s.slug",
    "s.title",
    "s.directory",
    "s.time_created",
    "s.time_updated",
    ...optional.filter((c) => cols.has(c)).map((c) => `s.${c}`),
  ];

  const canJoinProject = cols.has("project_id") && tableColumns(db, "project").has("worktree");
  if (canJoinProject) selected.push("p.worktree");

  return `
      SELECT ${selected.join(", ")}
      FROM session s
      ${canJoinProject ? "LEFT JOIN project p ON p.id = s.project_id" : ""}
      ${cols.has("parent_id") ? "WHERE s.parent_id IS NULL" : ""}
      ORDER BY s.time_updated DESC
    `;
}

export function listSessionsFromDb(db: Database): SessionInfo[] {
  const rows: OpencodeSessionRow[] = rowValues(db, buildSessionSelect(db));

  // Aggregate stats are computed with a handful of GROUP BY queries (one per
  // metric) instead of per-session round trips, so discovery scales with the
  // number of distinct queries rather than the number of sessions.
  const statsBySession = buildSessionStats(db);

  const sessions: SessionInfo[] = [];
  for (const row of rows) {
    const stats = statsBySession.get(row.id);
    if (!stats) continue;
    const info = sessionInfoFromRow(row, stats);
    if (info) sessions.push(info);
  }
  return sessions;
}

interface SessionStats {
  messageCount: number;
  promptCount: number;
  toolCallCount: number;
  editCountEst: number;
  firstPrompt: string;
  durationMs?: number;
}

function buildSessionStats(db: Database): Map<string, SessionStats> {
  const messageCounts = countBySession(
    db,
    `SELECT session_id, count(*) AS c FROM message GROUP BY session_id`,
  );
  const promptCounts = countBySession(
    db,
    `
      SELECT m.session_id, count(DISTINCT m.id) AS c
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      GROUP BY m.session_id
    `,
  );
  const toolCounts = countBySession(
    db,
    `
      SELECT session_id, count(*) AS c
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
      GROUP BY session_id
    `,
  );
  const editToolCounts = countBySession(
    db,
    `
      SELECT session_id, count(*) AS c
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
        AND json_extract(data, '$.tool') IN ('edit', 'write', 'patch')
      GROUP BY session_id
    `,
  );
  const firstPrompts = firstUserPrompts(db);
  const durations = activeDurationsBySession(db);

  const map = new Map<string, SessionStats>();
  for (const row of messageCounts) {
    const [sessionId, messageCount] = row;
    if (messageCount <= 0) continue;
    map.set(sessionId, {
      messageCount,
      promptCount: promptCounts.get(sessionId) ?? 0,
      toolCallCount: toolCounts.get(sessionId) ?? 0,
      editCountEst: editToolCounts.get(sessionId) ?? 0,
      firstPrompt: firstPrompts.get(sessionId) ?? "",
      durationMs: durations.get(sessionId),
    });
  }
  return map;
}

/** Estimate active time from message activity, capping long idle gaps. */
function activeDurationsBySession(db: Database): Map<string, number> {
  const timestamps = new Map<string, string[]>();
  for (const row of rowValues(
    db,
    `SELECT session_id, time_created FROM message ORDER BY session_id ASC, time_created ASC`,
  )) {
    const sessionId = String(row.session_id ?? "");
    const timestamp = toIsoMs(Number(row.time_created));
    if (!sessionId || !timestamp) continue;
    const values = timestamps.get(sessionId) || [];
    values.push(timestamp);
    timestamps.set(sessionId, values);
  }

  const durations = new Map<string, number>();
  for (const [sessionId, values] of timestamps) {
    const durationMs = estimateActiveDuration(values);
    if (durationMs !== undefined) durations.set(sessionId, durationMs);
  }
  return durations;
}

/** Map session_id → aggregate count for a `GROUP BY session_id` query. */
function countBySession(db: Database, sql: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rowValues(db, sql)) {
    const id = String(row.session_id ?? "");
    if (!id) continue;
    map.set(id, Number(row.c ?? 0));
  }
  return map;
}

/** Map session_id → the first user text prompt (earliest by message time). */
function firstUserPrompts(db: Database): Map<string, string> {
  const map = new Map<string, string>();
  const rows = rowValues(
    db,
    `
      SELECT m.session_id, m.time_created, p.data
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY m.session_id ASC, m.time_created ASC
    `,
  );
  for (const row of rows) {
    const sessionId = String(row.session_id ?? "");
    if (!sessionId || map.has(sessionId)) continue;
    let text = "";
    try {
      const parsed = JSON.parse(row.data as string) as { text?: string };
      text = typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      // skip malformed part; fall through to keep map entry reserved
    }
    map.set(sessionId, text);
  }
  return map;
}

function sessionInfoFromRow(row: OpencodeSessionRow, stats: SessionStats): SessionInfo | null {
  if (!row.id || !row.directory) return null;

  const firstPrompt = cleanPromptText(stats.firstPrompt);
  if (!firstPrompt) return null;

  const model = modelFromSessionRow(row);

  const dbPath = opencodeDbPath();
  const markerPath = `${dbPath}#session:${row.id}`;

  return {
    provider: OPENCODE_PROVIDER,
    sessionId: row.id,
    slug: row.slug || row.id.slice(0, 8),
    title: row.title || undefined,
    project: shortenPath(row.directory),
    cwd: row.directory,
    version: row.version || "",
    gitBranch: undefined,
    gitRepo: undefined,
    timestamp: toIsoMs(row.time_updated) || new Date().toISOString(),
    lineCount: stats.messageCount,
    fileSize: 0,
    filePath: markerPath,
    filePaths: [markerPath],
    hasSqlite: true,
    firstPrompt,
    prompts: [firstPrompt],
    promptCount: stats.promptCount,
    toolCallCount: stats.toolCallCount,
    model,
    durationMsEst: stats.durationMs,
    editCountEst: stats.editCountEst,
  };
}

function modelFromSessionRow(row: OpencodeSessionRow): string | undefined {
  if (!row.model) return undefined;
  try {
    const parsed = JSON.parse(row.model) as { id?: string };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function toIsoMs(value?: number): string | undefined {
  if (!value || value <= 0) return undefined;
  const millis = value < 1_577_836_800_000 ? value * 1000 : value;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { opencodeDataDir };
