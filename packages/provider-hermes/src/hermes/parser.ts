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
import {
  hermesDataDir,
  hermesDbPath,
  hermesDbPaths,
  hermesProfileDir,
  openAllHermesDbs,
  openHermesDb,
} from "./sqlite.js";
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
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  profile_name: string | null;
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

function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    return rowValues(db, `PRAGMA table_info(${table})`).some((row) => row.name === column);
  } catch {
    return false;
  }
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

  // Prefer the DB hinted by the marker path (fast path for the common case).
  const hinted = hintedDbPath(paths, sessionInfo);
  if (hinted) {
    const opened = await openHermesDb(hinted);
    if (opened) {
      try {
        const row = firstValue(opened.db, "SELECT id FROM sessions WHERE id = ?", {
          sid: sessionId,
        });
        if (row) return parseSessionFromDb(opened.db, sessionId, sessionInfo, opened.dbPath);
      } finally {
        opened.db.close();
      }
    }
  }

  const all = await openAllHermesDbs();
  if (all.length === 0) {
    throw new Error(
      `Hermes database not found (searched: ${hermesDbPaths().join(", ") || hermesDbPath()})`,
    );
  }
  // Find the winning DB while handles are live, close everything, then re-open
  // just the winner fresh for parsing — keeps WASM handle ownership simple.
  let winnerPath: string | undefined;
  for (const entry of all) {
    try {
      const row = firstValue(entry.db, "SELECT id FROM sessions WHERE id = ?", { sid: sessionId });
      if (row) {
        winnerPath = entry.dbPath;
        break;
      }
    } catch {
      // ignore per-DB probe errors
    }
  }
  for (const { db } of all) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (!winnerPath) {
    throw new Error(`Hermes session '${sessionId}' not found in any known database`);
  }
  const opened = await openHermesDb(winnerPath);
  if (!opened) throw new Error(`Hermes session '${sessionId}' not found in any known database`);
  try {
    return parseSessionFromDb(opened.db, sessionId, sessionInfo, winnerPath);
  } finally {
    opened.db.close();
  }
}

function hintedDbPath(paths: string[], sessionInfo?: SessionInfo): string | undefined {
  for (const p of paths) {
    const idx = p.indexOf("#session:");
    if (idx >= 0) {
      const dbPath = p.slice(0, idx);
      if (dbPath) return dbPath;
    }
  }
  const fp = sessionInfo?.filePath;
  if (typeof fp === "string" && fp.includes("#session:")) {
    return fp.split("#session:")[0];
  }
  return undefined;
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
  sourceDbPath?: string,
): ProviderParseResult {
  const session = firstValue(db, `SELECT * FROM sessions WHERE id = ?`, {
    sid: sessionId,
  }) as HermesSessionRow | null;

  const compactedColumn = hasColumn(db, "messages", "compacted") ? "compacted" : "0 AS compacted";
  const messages = rowValues(
    db,
    `
      SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
             finish_reason, reasoning_content, ${compactedColumn}
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `,
    { sid: sessionId },
  ) as HermesMessageRow[];

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const summaryCompactions: Compaction[] = [];
  const skillsUsed = new Set<string>();
  const skillActivations: string[] = [];
  let totalTokens: TokenUsage | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  const sessionCwd = typeof session?.cwd === "string" ? session.cwd.trim() : "";
  const cwd = sessionCwd || sessionInfo?.cwd || hermesProfileDir(session?.profile_name) || "";
  const model = sessionInfo?.model || session?.model || undefined;
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  let truncatedResponses = 0;

  // Track assistant tool_use blocks awaiting their role='tool' result, keyed
  // by call id so parallel tool calls each resolve to the right block.
  const pendingResults = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();
  // Hermes persists a separate assistant row for the call and a tool row for
  // the result, each with its own timestamp. Track the call timestamp so we
  // can infer a provider-style duration for activity timelines and insights.
  const pendingStartMs = new Map<string, number>();

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
      if (isCompaction) {
        summaryCompactions.push({
          timestamp: timestamp || startTime || new Date().toISOString(),
          trigger: "hermes-compaction-summary",
        });
      }
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
      const callStartMs = toMillisValue(message.timestamp);
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
          _hasResult: false,
          ...(rawName === "skill_view" &&
          typeof mappedInput.name === "string" &&
          mappedInput.name.trim()
            ? { _skillName: mappedInput.name.trim() }
            : {}),
        };
        blocks.push(block);
        pendingResults.set(block.id, block);
        if (callStartMs !== undefined && Number.isFinite(callStartMs) && callStartMs > 0) {
          pendingStartMs.set(block.id, callStartMs);
        }

        if (rawName === "skill_view") {
          const skillName = typeof mappedInput.name === "string" ? mappedInput.name.trim() : "";
          if (skillName) {
            skillsUsed.add(skillName);
            skillActivations.push(skillName);
          }
        }
      }

      // Count truncation even when the row carried no renderable blocks — a
      // response cut off by max_tokens before any content is stored is still a
      // truncated response.
      if (message.finish_reason === "max_tokens") truncatedResponses++;
      if (blocks.length === 0) continue;
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
      const result = (message.content || "").trim();
      if (!block) {
        // A persisted tool result is concrete evidence of an invocation even
        // when its assistant start record was lost during compaction/export.
        // Keep it as a synthetic assistant tool block instead of undercounting.
        const rawName = message.tool_name || "Unknown";
        turns.push({
          role: "assistant",
          timestamp,
          blocks: [
            {
              type: "tool_use",
              id: message.tool_call_id || `hermes-orphan-${message.id}`,
              name: mapHermesToolName(rawName),
              input: mapHermesToolArgs(rawName, {}),
              _hasResult: true,
              _result: result,
            },
          ],
          ...(model ? { model } : {}),
        });
        continue;
      }
      block._hasResult = true;
      if (result) block._result = result;
      else block._result = "";
      const startMs = pendingStartMs.get(block.id);
      const endMs = toMillisValue(message.timestamp);
      if (startMs !== undefined && endMs !== undefined) {
        const durationMs = inferredToolDurationMs(startMs, endMs);
        if (durationMs !== undefined) {
          block._durationMs = durationMs;
          block._durationSource = "timestamp";
          block._durationAnchor = "start";
        }
      }
      pendingResults.delete(block.id);
      pendingStartMs.delete(block.id);
      continue;
    }

    // role='session_meta' and anything unknown: skip
  }

  // Hermes compression marks each pre-compaction transcript run with
  // compacted=1 (the rows stay in the DB, so the replay keeps full history).
  // Every compacted run boundary is its own compaction event — long sessions
  // can compact several times.
  let previousCompacted = false;
  for (const message of messages) {
    const isCompacted = message.compacted === 1;
    if (isCompacted && !previousCompacted) {
      compactions.push({
        timestamp: toIsoMs(message.timestamp) || startTime || new Date().toISOString(),
        trigger: "hermes-compaction",
      });
    }
    previousCompacted = isCompacted;
  }
  if (summaryCompactions.length > compactions.length) {
    compactions.push(...summaryCompactions.slice(compactions.length));
  }

  const tokenUsage = usageFromSession(session);
  if (tokenUsage) totalTokens = tokenUsage;

  const tokenUsageByModel = usageByModelFromDb(db, sessionId);
  const reportedCostUsd = reportedCostFromSession(session);

  const defaultSource: DataSourceInfo = {
    primary: "sqlite",
    sources: [sourceDbPath ?? hermesDbPath()],
    notes: ["Discovered from the Hermes SQLite database."],
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
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    compactions: compactions.length > 0 ? compactions : undefined,
    gitBranch: session?.git_branch || undefined,
    ...(skillsUsed.size > 0 ? { skillsUsed: Array.from(skillsUsed) } : {}),
    ...(skillActivations.length > 0 ? { skillActivations } : {}),
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

/**
 * Provider-reported cost for the session. Hermes maintains an estimate and,
 * when billing data is available, an actual cost — prefer the actual value
 * and only report positive numbers (status "included"/"unknown" store 0).
 */
function reportedCostFromSession(session: HermesSessionRow | null): number | undefined {
  if (!session) return undefined;
  const actual = Number(session.actual_cost_usd ?? 0);
  if (Number.isFinite(actual) && actual > 0) return actual;
  const estimated = Number(session.estimated_cost_usd ?? 0);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : undefined;
}

/** Per-model token usage from the session_model_usage table (Hermes ≥ 0.20). */
function usageByModelFromDb(
  db: Database,
  sessionId: string,
): Record<string, TokenUsage> | undefined {
  let rows: HermesModelUsageRow[];
  try {
    rows = rowValues(
      db,
      `
        SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
               reasoning_tokens
        FROM session_model_usage
        WHERE session_id = ?
      `,
      { sid: sessionId },
    ) as HermesModelUsageRow[];
  } catch {
    // Per-model billing was added after the original Hermes schema. The
    // session-level counters remain authoritative when this table is absent.
    return undefined;
  }
  if (rows.length === 0) return undefined;

  const byModel: Record<string, TokenUsage> = {};
  for (const row of rows) {
    const model = row.model || "unknown";
    const usage: TokenUsage = {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheCreationTokens: Number(row.cache_write_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    };
    const existing = byModel[model];
    if (!existing) {
      byModel[model] = usage;
      continue;
    }
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    existing.cacheCreationTokens += usage.cacheCreationTokens;
    existing.cacheReadTokens += usage.cacheReadTokens;
  }
  return byModel;
}

function toIsoMs(value?: number): string | undefined {
  const millis = toMillisValue(value);
  if (millis === undefined) return undefined;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toMillisValue(value?: number): number | undefined {
  if (!value || value <= 0) return undefined;
  return value < 1_577_836_800_000 ? value * 1000 : value;
}

/**
 * Hermes stores the tool call and result as separate rows. Infer duration from
 * those timestamps, but ignore ultra-long gaps that belong to user-idle or
 * compaction rather than tool execution.
 */
function inferredToolDurationMs(startMs: number, endMs: number): number | undefined {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  const durationMs = endMs - startMs;
  return durationMs > 0 && durationMs < 30 * 60 * 1000 ? durationMs : undefined;
}

export { hermesDataDir };
