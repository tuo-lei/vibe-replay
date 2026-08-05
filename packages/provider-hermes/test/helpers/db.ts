import initSqlJs, { type Database } from "sql.js";
import type { SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic | undefined;
async function getSql(): Promise<SqlJsStatic> {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

export interface HermesSessionSeed {
  id: string;
  title?: string | null;
  cwd?: string | null;
  model?: string | null;
  startedAt?: number;
  endedAt?: number | null;
  lastActivityAt?: number | null;
  messageCount?: number;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  gitBranch?: string | null;
  gitRepoRoot?: string | null;
  pinned?: number;
}

export interface HermesMessageSeed {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "session_meta";
  content?: string | null;
  toolCallId?: string | null;
  toolCalls?: unknown | null;
  toolName?: string | null;
  timestamp?: number;
  finishReason?: string | null;
  reasoningContent?: string | null;
  compacted?: number;
}

/**
 * Build an in-memory sql.js Database shaped like Hermes's `state.db`
 * (sessions / messages / session_model_usage tables) and seed it.
 */
export async function buildHermesDb(seeds: {
  sessions?: HermesSessionSeed[];
  messages: HermesMessageSeed[];
  modelUsage?: Array<{
    sessionId: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  }>;
}): Promise<Database> {
  const sql = await getSql();
  const db = new sql.Database();

  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      model TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      last_activity_at REAL,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      git_branch TEXT,
      git_repo_root TEXT,
      parent_session_id TEXT,
      profile_name TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      end_reason TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      display_kind TEXT,
      display_metadata TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '',
      billing_mode TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      cost_status TEXT,
      cost_source TEXT,
      first_seen REAL,
      last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    );
    CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
  `);

  for (const s of seeds.sessions || []) {
    const startedAt = s.startedAt ?? 1_800_000_000;
    db.run(
      `INSERT INTO sessions (
         id, source, title, cwd, model, started_at, ended_at, last_activity_at,
         message_count, tool_call_count, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens,
         git_branch, git_repo_root, pinned
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id,
        "cli",
        s.title ?? null,
        s.cwd ?? "/Users/test/project",
        s.model ?? "deepseek-v4-flash-free",
        startedAt,
        s.endedAt ?? null,
        s.lastActivityAt ?? null,
        s.messageCount ?? 0,
        s.toolCallCount ?? 0,
        s.inputTokens ?? 0,
        s.outputTokens ?? 0,
        s.cacheReadTokens ?? 0,
        s.cacheWriteTokens ?? 0,
        s.reasoningTokens ?? 0,
        s.gitBranch ?? null,
        s.gitRepoRoot ?? null,
        s.pinned ?? 0,
      ],
    );
  }

  for (const m of seeds.messages) {
    db.run(
      `INSERT INTO messages (
         id, session_id, role, content, tool_call_id, tool_calls, tool_name,
         timestamp, finish_reason, reasoning_content, compacted
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        m.id,
        m.sessionId,
        m.role,
        m.content ?? null,
        m.toolCallId ?? null,
        m.toolCalls != null ? JSON.stringify(m.toolCalls) : null,
        m.toolName ?? null,
        m.timestamp ?? 1_800_000_000,
        m.finishReason ?? null,
        m.reasoningContent ?? null,
        m.compacted ?? 0,
      ],
    );
  }

  for (const u of seeds.modelUsage || []) {
    db.run(
      `INSERT INTO session_model_usage (
         session_id, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, reasoning_tokens
       ) VALUES (?,?,?,?,?,?,?)`,
      [
        u.sessionId,
        u.model,
        u.inputTokens ?? 0,
        u.outputTokens ?? 0,
        u.cacheReadTokens ?? 0,
        u.cacheWriteTokens ?? 0,
        u.reasoningTokens ?? 0,
      ],
    );
  }

  return db;
}

/** OpenAI-style tool_calls payload as stored on assistant rows. */
export function toolCallsFor(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): Array<{
  id: string;
  call_id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  return calls.map((c) => ({
    id: c.id,
    call_id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
}
