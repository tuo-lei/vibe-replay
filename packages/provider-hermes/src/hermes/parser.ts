/// <reference path="../sql-js.d.ts" />
import type { Database } from "sql.js";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import type { ContentBlock, ParsedTurn, SessionInfo } from "@vibe-replay/provider-contract";
import type {
  Compaction,
  DataSourceInfo,
  ProviderParseResult,
  TokenUsage,
} from "@vibe-replay/provider-contract";
import { addParseWarning, compactWarningSample } from "@vibe-replay/provider-contract/warnings";
import { openHermesDb, hermesDataDir, hermesDbPath } from "./sqlite.js";
import { mapHermesToolArgs, mapHermesToolName } from "./tool-mapping.js";

interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  finish_reason: string | null;
  reasoning_content: string | null;
  compacted: number | null;
}

interface HermesSessionRow {
  id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  git_branch: string | null;
  git_repo_root: string | null;
  end_reason: string | null;
}

interface HermesModelUsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

interface HermesToolCall {
  id?: string;
  call_id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
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

export async function parseHermesSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const sessionId = resolveSessionId(paths, sessionInfo);
  if (!sessionId) {
    throw new Error(
      "hermes parse requires a session id (pass a Hermes session path like `~/.hermes/state.db#session:<id>` or a `--session <id>` id)",
    );
  }

  const opened = await openHermesDb();
  if (!opened) {
    throw new Error(`Hermes database not found at ${hermesDbPath()}`);
  }
  const { db } = opened;
  try {
    return parseSessionFromDb(db, sessionId, sessionInfo);
  } finally {
    db.close();
  }
}

/**
 * Extract the Hermes session id from the filePath markers written by
 * discovery (`<dbPath>#session:<id>`), or from sessionInfo, or from a raw
 * Hermes session id passed directly on the CLI.
 */
export function resolveSessionId(paths: string[], sessionInfo?: SessionInfo): string | undefined {
  if (sessionInfo?.sessionId) return sessionInfo.sessionId;
  for (const path of paths) {
    const marker = "#session:";
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      const id = path
        .slice(idx + marker.length)
        .split(/[/?#]/, 1)[0]
        ?.trim();
      if (id) return id;
    }
    if (/^\d{8}_\d{6}_/.test(path) || path.startsWith("session_")) return path;
  }
  return undefined;
}

export function parseSessionFromDb(
  db: Database,
  sessionId: string,
  sessionInfo?: SessionInfo,
): ProviderParseResult {
  const session = firstValue(db, `SELECT * FROM sessions WHERE id = ?`, {
    sid: sessionId,
  }) as HermesSessionRow | null;

  const messages = rowValues(
    db,
    `
      SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
             finish_reason, reasoning_content, compacted
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `,
    { sid: sessionId },
  ) as HermesMessageRow[];

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const skillsUsed = new Set<string>();
  let totalTokens: TokenUsage | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  const cwd = session?.cwd || sessionInfo?.cwd || "";
  const model = sessionInfo?.model || session?.model || undefined;
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  let truncatedResponses = 0;

  // Track assistant tool_use blocks awaiting their role='tool' result, keyed
  // by call id so parallel tool calls each resolve to the right block.
  const pendingResults = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();

  for (const message of messages) {
    const timestamp = toIsoMs(message.timestamp);
    if (timestamp) {
      allTimestamps.push(timestamp);
      if (!startTime) startTime = timestamp;
      endTime = timestamp;
    }

    if (message.role === "user") {
      const text = (message.content || "").trim();
      if (!text) continue; // skip empty/injected user rows
      // Hermes records context compaction as a user row whose content is the
      // generated summary, prefixed with a fixed marker. Mirror claude-code's
      // isCompactSummary handling so the viewer renders a compaction scene.
      const isCompaction = text.startsWith("[CONTEXT COMPACTION");
      turns.push({
        role: "user",
        ...(isCompaction ? { subtype: "compaction-summary" as const } : {}),
        timestamp,
        blocks: [{ type: "text", text }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const thinking = (message.reasoning_content || "").trim();
      if (thinking) blocks.push({ type: "thinking", thinking });
      const text = (message.content || "").trim();
      if (text) blocks.push({ type: "text", text });

      const toolCalls = parseToolCalls(message.tool_calls, message.id, parseWarnings);
      for (const call of toolCalls) {
        const rawName = call.function?.name || "";
        const input = parseArguments(call.function?.arguments, message.id, parseWarnings);
        const name = mapHermesToolName(rawName);
        const mappedInput = mapHermesToolArgs(rawName, input);
        const block: Extract<ContentBlock, { type: "tool_use" }> = {
          type: "tool_use",
          id: call.call_id || call.id || `hermes-${rawName}-${message.id}`,
          name,
          input: mappedInput,
        };
        blocks.push(block);
        pendingResults.set(block.id, block);

        if (rawName === "skill_view") {
          const skillName = typeof mappedInput.name === "string" ? mappedInput.name : "";
          if (skillName) skillsUsed.add(skillName);
        }
      }

      if (blocks.length === 0) continue;
      if (message.finish_reason === "max_tokens") truncatedResponses++;
      turns.push({
        role: "assistant",
        timestamp,
        blocks,
        ...(model ? { model } : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      const block = message.tool_call_id ? pendingResults.get(message.tool_call_id) : undefined;
      if (!block) continue; // orphan result (no matching tool_use) — drop
      const result = (message.content || "").trim();
      if (result) block._result = result;
      pendingResults.delete(block.id);
      continue;
    }

    // role='session_meta' and anything unknown: skip
  }

  // Hermes compression marks the pre-compaction transcript rows compacted=1
  // (they stay in the DB, so the replay keeps full history). Record a single
  // compaction event so the viewer can annotate the context change.
  const firstCompacted = messages.find((m) => m.compacted === 1);
  if (firstCompacted) {
    compactions.push({
      timestamp: toIsoMs(firstCompacted.timestamp) || startTime || new Date().toISOString(),
      trigger: "hermes-compaction",
    });
  }

  const tokenUsage = usageFromSession(session);
  if (tokenUsage) totalTokens = tokenUsage;

  const tokenUsageByModel = usageByModelFromDb(db, sessionId);

  const defaultSource: DataSourceInfo = {
    primary: "sqlite",
    sources: [hermesDbPath()],
    notes: ["Discovered from the Hermes SQLite database (~/.hermes/state.db)."],
  };

  return {
    sessionId: session?.id || sessionId,
    slug: session?.id || sessionId.slice(0, 8),
    title: session?.title || sessionInfo?.title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(allTimestamps),
    turns,
    dataSource: "sqlite",
    dataSourceInfo: defaultSource,
    ...(totalTokens ? { tokenUsage: totalTokens } : {}),
    ...(tokenUsageByModel && Object.keys(tokenUsageByModel).length > 0
      ? { tokenUsageByModel }
      : {}),
    compactions: compactions.length > 0 ? compactions : undefined,
    gitBranch: session?.git_branch || undefined,
    ...(skillsUsed.size > 0 ? { skillsUsed: Array.from(skillsUsed) } : {}),
    parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
    ...(truncatedResponses > 0 ? { truncatedResponses } : {}),
  };
}

function parseToolCalls(
  raw: string | null,
  messageId: number,
  warnings: NonNullable<ProviderParseResult["parseWarnings"]>,
): HermesToolCall[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as HermesToolCall[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    addParseWarning(warnings, {
      kind: "malformed-json",
      source: "hermes message",
      message: `message ${messageId}: unparseable tool_calls, skipped`,
      sample: compactWarningSample(raw),
    });
    return [];
  }
}

function parseArguments(
  raw: string | undefined,
  messageId: number,
  warnings: NonNullable<ProviderParseResult["parseWarnings"]>,
): Record<string, any> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    addParseWarning(warnings, {
      kind: "malformed-json",
      source: "hermes message",
      message: `message ${messageId}: unparseable tool arguments, using empty input`,
      sample: compactWarningSample(raw),
    });
    return {};
  }
}

function usageFromSession(session: HermesSessionRow | null): TokenUsage | undefined {
  if (!session) return undefined;
  const usage: TokenUsage = {
    inputTokens: Number(session.input_tokens ?? 0),
    outputTokens: Number(session.output_tokens ?? 0),
    cacheCreationTokens: Number(session.cache_write_tokens ?? 0),
    cacheReadTokens: Number(session.cache_read_tokens ?? 0),
  };
  if (Object.values(usage).every((v) => v === 0)) return undefined;
  return usage;
}

/** Per-model token usage from the session_model_usage table (Hermes ≥ 0.20). */
function usageByModelFromDb(
  db: Database,
  sessionId: string,
): Record<string, TokenUsage> | undefined {
  const rows = rowValues(
    db,
    `
      SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens
      FROM session_model_usage
      WHERE session_id = ?
    `,
    { sid: sessionId },
  ) as HermesModelUsageRow[];
  if (rows.length === 0) return undefined;

  const byModel: Record<string, TokenUsage> = {};
  for (const row of rows) {
    const usage: TokenUsage = {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationTokens: Number(row.cache_write_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    };
    byModel[row.model || "unknown"] = usage;
  }
  return byModel;
}

function toIsoMs(value?: number): string | undefined {
  if (!value || value <= 0) return undefined;
  const millis = value < 1_577_836_800_000 ? value * 1000 : value;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { hermesDataDir };
