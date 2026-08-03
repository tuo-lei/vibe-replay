/// <reference path="../sql-js.d.ts" />
import type { Database } from "sql.js";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
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

function firstValue(db: Database, sql: string, params: Record<string, any> = {}): any {
  const rows = rowValues(db, sql, params);
  return rows[0] ?? null;
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

export function listSessionsFromDb(db: Database): SessionInfo[] {
  const rows: OpencodeSessionRow[] = rowValues(
    db,
    `
      SELECT s.id, s.slug, s.title, s.directory, s.version, s.agent, s.model,
             s.time_created, s.time_updated, s.cost, s.tokens_input, s.tokens_output,
             p.worktree
      FROM session s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.parent_id IS NULL
      ORDER BY s.time_updated DESC
    `,
  );

  const sessions: SessionInfo[] = [];
  for (const row of rows) {
    const info = sessionInfoFromRow(db, row);
    if (info) sessions.push(info);
  }
  return sessions;
}

function sessionInfoFromRow(db: Database, row: OpencodeSessionRow): SessionInfo | null {
  if (!row.id || !row.directory) return null;

  const messageCount = countMessages(db, row.id);
  if (messageCount <= 0) return null;

  const firstMsg = firstUserMessage(db, row.id);
  const firstPrompt = cleanPromptText(firstMsg?.text || "");
  if (!firstPrompt) return null;

  const promptCount = countUserPrompts(db, row.id);
  const toolCallCount = countToolCalls(db, row.id);
  const editCountEst = countEditTools(db, row.id);
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
    lineCount: messageCount,
    fileSize: 0,
    filePath: markerPath,
    filePaths: [markerPath],
    hasSqlite: true,
    firstPrompt,
    prompts: [firstPrompt],
    promptCount,
    toolCallCount,
    model,
    durationMsEst:
      row.time_created > 0 && row.time_updated > row.time_created
        ? row.time_updated - row.time_created
        : undefined,
    editCountEst,
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

function countMessages(db: Database, sessionId: string): number {
  const row = firstValue(db, `SELECT count(*) AS c FROM message WHERE session_id = ?`, {
    sid: sessionId,
  });
  return Number(row?.c ?? 0);
}

function firstUserMessage(db: Database, sessionId: string): { text: string } | null {
  const row = firstValue(
    db,
    `
      SELECT p.data
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE m.session_id = ?
        AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY m.time_created ASC
      LIMIT 1
    `,
    { sid: sessionId },
  );
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data as string) as { text?: string };
    return { text: typeof parsed.text === "string" ? parsed.text : "" };
  } catch {
    return null;
  }
}

function countUserPrompts(db: Database, sessionId: string): number {
  const row = firstValue(
    db,
    `
      SELECT count(DISTINCT m.id) AS c
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE m.session_id = ?
        AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
    `,
    { sid: sessionId },
  );
  return Number(row?.c ?? 0);
}

function countToolCalls(db: Database, sessionId: string): number {
  const row = firstValue(
    db,
    `
      SELECT count(*) AS c
      FROM part
      WHERE session_id = ?
        AND json_extract(data, '$.type') = 'tool'
    `,
    { sid: sessionId },
  );
  return Number(row?.c ?? 0);
}

function countEditTools(db: Database, sessionId: string): number {
  const row = firstValue(
    db,
    `
      SELECT count(*) AS c
      FROM part
      WHERE session_id = ?
        AND json_extract(data, '$.type') = 'tool'
        AND json_extract(data, '$.tool') IN ('edit', 'write', 'patch')
    `,
    { sid: sessionId },
  );
  return Number(row?.c ?? 0);
}

function toIsoMs(value?: number): string | undefined {
  if (!value || value <= 0) return undefined;
  const millis = value < 1_577_836_800_000 ? value * 1000 : value;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { opencodeDataDir };
