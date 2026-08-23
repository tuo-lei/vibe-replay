/// <reference path="../sql-js.d.ts" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "sql.js";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { hermesDataDir, hermesDbPath, openAllHermesDbs } from "./sqlite.js";

export const HERMES_PROVIDER = "hermes";

export interface HermesSessionRow {
  id: string;
  source: string | null;
  title: string | null;
  cwd: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number | null;
  message_count: number | null;
  tool_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
  git_branch: string | null;
  git_repo_root: string | null;
  parent_session_id: string | null;
  profile_name: string | null;
  pinned: number | null;
  end_reason: string | null;
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

export async function discoverHermesSessions(): Promise<SessionInfo[]> {
  const all = await openAllHermesDbs();
  if (all.length === 0) return [];
  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();
  try {
    for (const { db, dbPath } of all) {
      const fromDb = listSessionsFromDb(db, dbPath);
      for (const s of fromDb) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        sessions.push(s);
      }
    }
  } finally {
    for (const { db } of all) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  // Deterministic ordering: newest last_activity first across profiles.
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

export function listSessionsFromDb(db: Database, dbPathOverride?: string): SessionInfo[] {
  const rows = rowValues(
    db,
    `
      SELECT id, source, title, cwd, model, started_at, ended_at, last_activity_at,
             message_count, tool_call_count, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens,
             estimated_cost_usd, git_branch, git_repo_root, parent_session_id,
             profile_name, pinned, end_reason
      FROM sessions
      ORDER BY COALESCE(last_activity_at, ended_at, started_at) DESC
    `,
  ) as HermesSessionRow[];

  // Aggregate stats are computed with a handful of GROUP BY queries (one per
  // metric) instead of per-session round trips, so discovery scales with the
  // number of distinct queries rather than the number of sessions.
  const statsBySession = buildSessionStats(db, rows);

  const version = hermesVersion();
  const fallbackDbPath = dbPathOverride ?? hermesDbPath();
  const sessions: SessionInfo[] = [];
  for (const row of rows) {
    const stats = statsBySession.get(row.id);
    if (!stats) continue;
    const info = sessionInfoFromRow(row, stats, version, fallbackDbPath);
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
}

function buildSessionStats(db: Database, rows: HermesSessionRow[]): Map<string, SessionStats> {
  // message/tool counts come straight from the sessions row columns that
  // Hermes maintains; prompts and edits need message-level scans.
  const promptCounts = countBySession(
    db,
    `
      SELECT session_id, count(*) AS c
      FROM messages
      WHERE role = 'user'
        AND content IS NOT NULL
        AND length(trim(content)) > 0
      GROUP BY session_id
    `,
  );
  const editToolCounts = countBySession(
    db,
    `
      SELECT session_id, count(*) AS c
      FROM messages
      WHERE role = 'assistant'
        AND (
          tool_calls LIKE '%"name":"patch"%'
          OR tool_calls LIKE '%"name": "patch"%'
          OR tool_calls LIKE '%"name":"write_file"%'
          OR tool_calls LIKE '%"name": "write_file"%'
        )
      GROUP BY session_id
    `,
  );
  const firstPrompts = firstUserPrompts(db);

  const map = new Map<string, SessionStats>();
  for (const row of rows) {
    if (!row.id) continue;
    map.set(row.id, {
      messageCount: Number(row.message_count ?? 0),
      promptCount: promptCounts.get(row.id) ?? 0,
      toolCallCount: Number(row.tool_call_count ?? 0),
      editCountEst: editToolCounts.get(row.id) ?? 0,
      firstPrompt: firstPrompts.get(row.id) ?? "",
    });
  }
  return map;
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

/** Map session_id → the first non-empty user prompt (earliest by rowid). */
function firstUserPrompts(db: Database): Map<string, string> {
  const map = new Map<string, string>();
  const rows = rowValues(
    db,
    `
      SELECT m.session_id, m.content
      FROM messages m
      WHERE m.id IN (
        SELECT MIN(id) FROM messages
        WHERE role = 'user'
          AND content IS NOT NULL
          AND length(trim(content)) > 0
        GROUP BY session_id
      )
    `,
  );
  for (const row of rows) {
    const sessionId = String(row.session_id ?? "");
    if (!sessionId || map.has(sessionId)) continue;
    map.set(sessionId, String(row.content ?? ""));
  }
  return map;
}

function sessionInfoFromRow(
  row: HermesSessionRow,
  stats: SessionStats,
  version: string,
  dbPath?: string,
): SessionInfo | null {
  if (!row.id) return null;

  const firstPrompt = cleanPromptText(stats.firstPrompt);
  if (!firstPrompt) return null;

  const resolvedDbPath = dbPath ?? hermesDbPath();
  const markerPath = `${resolvedDbPath}#session:${row.id}`;
  const lastActivity = row.last_activity_at ?? row.ended_at ?? row.started_at;

  return {
    provider: HERMES_PROVIDER,
    sessionId: row.id,
    slug: row.id,
    title: row.title || undefined,
    project: shortenPath(row.cwd || ""),
    cwd: row.cwd || "",
    version,
    gitBranch: row.git_branch || undefined,
    gitRepo: undefined,
    timestamp: toIsoMs(lastActivity) || new Date().toISOString(),
    lineCount: stats.messageCount,
    fileSize: 0,
    filePath: markerPath,
    filePaths: [markerPath],
    hasSqlite: true,
    firstPrompt,
    prompts: [firstPrompt],
    promptCount: stats.promptCount,
    toolCallCount: stats.toolCallCount,
    model: row.model || undefined,
    durationMsEst:
      row.started_at > 0 && lastActivity > row.started_at
        ? toMillis(lastActivity) - toMillis(row.started_at)
        : undefined,
    editCountEst: stats.editCountEst,
    isStarred: row.pinned === 1,
  };
}

let cachedVersion: string | undefined;

/**
 * Hermes version, read from the update-check stamp Hermes itself writes
 * (`~/.hermes/.update_check` → `{"ver": "0.20.0", ...}`). Cached after the
 * first read; empty string when the file is missing or unparseable.
 */
export function hermesVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = readFileSync(join(hermesDataDir(), ".update_check"), "utf8");
    const parsed = JSON.parse(raw) as { ver?: unknown };
    cachedVersion = typeof parsed.ver === "string" ? parsed.ver : "";
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}

/**
 * Hermes timestamps are Unix seconds in current builds; older or future
 * builds may store milliseconds. Normalize both to milliseconds so callers
 * (ISO timestamps and duration math) agree on units.
 */
function toMillis(value: number): number {
  return value < 1_577_836_800_000 ? value * 1000 : value;
}

function toIsoMs(value?: number): string | undefined {
  if (!value || value <= 0) return undefined;
  const d = new Date(toMillis(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { hermesDataDir };
