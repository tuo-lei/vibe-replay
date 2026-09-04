import initSqlJs, { type Database } from "sql.js";
import type { SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic | undefined;
async function getSql(): Promise<SqlJsStatic> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

export interface DbSeed {
  id: string;
  slug?: string;
  title?: string;
  directory?: string;
  agent?: string | null;
  model?: string | null;
  parentId?: string | null;
  timeCreated?: number;
  timeUpdated?: number;
  cost?: number | null;
}

export interface MessageSeed {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  modelID?: string;
  finish?: string;
  timeCreated?: number;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  cost?: number;
  error?: { name?: string } | string;
  parts: Array<Record<string, unknown>>;
}

/**
 * Build an in-memory sql.js Database shaped like opencode's `opencode.db`
 * (session / message / part tables) and seed it with the given rows.
 */
export async function buildOpencodeDb(seeds: {
  session?: DbSeed[];
  messages: MessageSeed[];
}): Promise<Database> {
  const sql = await getSql();
  const db = new sql.Database();

  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      agent TEXT,
      model TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      cost INTEGER,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      tokens_cache_write INTEGER
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      name TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `);

  for (const s of seeds.session || []) {
    db.run(
      "INSERT INTO session (id, slug, title, directory, agent, model, parent_id, time_created, time_updated, cost) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        s.id,
        s.slug || `slug-${s.id}`,
        s.title || null,
        s.directory || "/Users/test/project",
        s.agent ?? null,
        s.model ?? JSON.stringify({ id: "deepseek-v4-flash-free", providerID: "opencode" }),
        s.parentId ?? null,
        s.timeCreated ?? 1_800_000_000_000,
        s.timeUpdated ?? 1_800_000_000_000,
        s.cost ?? null,
      ],
    );
  }

  let partId = 0;
  for (const m of seeds.messages) {
    const meta: Record<string, unknown> = {
      role: m.role,
      time: { created: m.timeCreated ?? 1_800_000_000_000 },
      type: "message",
    };
    if (m.modelID) meta.modelID = m.modelID;
    if (m.finish) meta.finish = m.finish;
    if (m.tokens) meta.tokens = m.tokens;
    if (m.cost !== undefined) meta.cost = m.cost;
    if (m.error !== undefined) meta.error = m.error;
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)", [
      m.id,
      m.sessionId,
      m.timeCreated ?? 1_800_000_000_000,
      JSON.stringify(meta),
    ]);
    for (const p of m.parts) {
      const id = `prt_${++partId}`;
      db.run(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)",
        [id, m.id, m.sessionId, m.timeCreated ?? 1_800_000_000_000, JSON.stringify(p)],
      );
    }
  }

  return db;
}
