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
import { openOpencodeDb, opencodeDataDir, opencodeDbPath } from "./sqlite.js";
import { mapOpencodeToolArgs, mapOpencodeToolName } from "./tool-mapping.js";
import { addParseWarning, compactWarningSample } from "@vibe-replay/provider-contract/warnings";

interface OpencodeMessageRow {
  id: string;
  session_id: string;
  data: string;
}

interface OpencodePartRow {
  message_id: string;
  data: string;
}

interface OpencodePart {
  type: string;
  tool?: string;
  callID?: string;
  text?: string;
  auto?: boolean;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    metadata?: { diff?: string };
    time?: { start?: number; end?: number };
  };
  url?: string;
  mime?: string;
  filename?: string;
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

interface SessionMetaRow {
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
}

interface MessageMeta {
  role: "user" | "assistant" | string;
  modelID?: string;
  time?: { created?: number; completed?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  finish?: string;
}

function parseMeta<T>(raw: string | undefined | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** True when raw JSON exists but `parseMeta` failed to decode it. */
function isUnparseable(raw: string | undefined | null): boolean {
  if (!raw) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

export async function parseOpencodeSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const sessionId = resolveSessionId(paths, sessionInfo);
  if (!sessionId) {
    throw new Error(
      "opencode parse requires a session id (pass an opencode session path like `~/.local/share/opencode/opencode.db#session:<id>` or a `--session ses_...` id)",
    );
  }

  const opened = await openOpencodeDb(hintedDbPath(paths, sessionInfo) || undefined);
  if (!opened) {
    throw new Error(`opencode database not found at ${opencodeDbPath()}`);
  }
  const { db } = opened;
  try {
    return parseSessionFromDb(db, sessionId, sessionInfo);
  } finally {
    db.close();
  }
}

/**
 * Extract the opencode session id from the filePath markers written by
 * discovery (`<dbPath>#session:<id>`), or from sessionInfo, or from a raw
 * `ses_...` id passed directly on the CLI.
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
    if (path.startsWith("ses_")) return path;
  }
  return undefined;
}

function hintedDbPath(paths: string[], sessionInfo?: SessionInfo): string | undefined {
  for (const path of paths) {
    const markerIndex = path.indexOf("#session:");
    if (markerIndex >= 0) {
      const dbPath = path.slice(0, markerIndex);
      if (dbPath) return dbPath;
    }
  }
  const filePath = sessionInfo?.filePath;
  if (filePath?.includes("#session:")) return filePath.split("#session:", 1)[0];
  return undefined;
}

export function parseSessionFromDb(
  db: Database,
  sessionId: string,
  sessionInfo?: SessionInfo,
): ProviderParseResult {
  const session = firstValue(db, `SELECT * FROM session WHERE id = ?`, {
    sid: sessionId,
  }) as SessionMetaRow | null;

  const messages = rowValues(
    db,
    `
      SELECT id, session_id, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `,
    { sid: sessionId },
  ) as OpencodeMessageRow[];

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const tokenByModel = new Map<string, TokenUsage>();
  const skillsUsed = new Set<string>();
  const skillActivations: string[] = [];
  let totalTokens: TokenUsage | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  const cwd = session?.directory || sessionInfo?.cwd || "";
  let model = sessionInfo?.model;
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  let truncatedResponses = 0;

  const modelMeta = parseMeta<{ id?: string }>(session?.model);
  if (modelMeta?.id && !model) model = modelMeta.id;
  else if (isUnparseable(session?.model)) {
    addParseWarning(parseWarnings, {
      kind: "malformed-json",
      source: "opencode session",
      message: "session model: unparseable data, using fallback",
      sample: compactWarningSample(session?.model ?? ""),
    });
  }

  for (const message of messages) {
    if (isUnparseable(message.data)) {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        source: "opencode message",
        message: `message ${message.id}: unparseable data, skipped`,
        sample: compactWarningSample(message.data),
      });
      continue;
    }
    const meta = parseMeta<MessageMeta>(message.data);
    if (!meta) continue;
    const timestampMs = meta.time?.completed || meta.time?.created;
    const timestamp = toIsoMs(timestampMs);
    if (timestamp) {
      allTimestamps.push(timestamp);
      if (!startTime) startTime = timestamp;
      endTime = timestamp;
    }

    // Per-model token aggregation (opencode records usage on assistant messages).
    if (meta.tokens && meta.modelID) {
      const usage = usageFromMeta(meta.tokens);
      if (usage) {
        mergeUsage(tokenByModel, meta.modelID, usage);
        totalTokens = mergeUsageTotal(totalTokens, usage);
      }
    }

    if (meta.role === "user") {
      // opencode writes a `compaction` part on a synthetic user message that
      // announces context compaction. Fetch the parts once and branch on the
      // compaction marker so user turns and compactions share a single query.
      const parts = partsForMessage(db, message.id, parseWarnings);
      const compactionPart = parts.find((p) => p.type === "compaction");
      if (compactionPart) {
        recordCompaction(compactions, timestamp, compactionPart);
        continue;
      }
      const userTurns = userTurnsFromPartsList(parts, timestamp);
      turns.push(...userTurns);
      continue;
    }

    if (meta.role === "assistant") {
      if (meta.finish === "error" || meta.finish === "unknown") {
        // opencode writes `finish: "error"` on failed steps; surface the last
        // text part (if any) so the failure is visible rather than dropped.
        const parts = partsForMessage(db, message.id, parseWarnings);
        const text = parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n");
        if (text.trim()) {
          turns.push({
            role: "assistant",
            timestamp,
            blocks: [{ type: "text", text }],
            model: meta.modelID,
          });
        }
        continue;
      }

      const blocks = assistantBlocksFromParts(db, message.id, parseWarnings);
      if (blocks.length === 0) continue;
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block._skillName) continue;
        skillsUsed.add(block._skillName);
        skillActivations.push(block._skillName);
      }
      if (meta.finish === "max_tokens") truncatedResponses++;

      const modelForTurn = meta.modelID || model;
      turns.push({
        role: "assistant",
        timestamp,
        blocks,
        ...(modelForTurn ? { model: modelForTurn } : {}),
      });
      continue;
    }
  }

  const tokenUsage = totalTokens;
  const tokenUsageByModel =
    tokenByModel.size > 0 ? Object.fromEntries(tokenByModel.entries()) : undefined;

  // opencode persists its own cumulative cost estimate on the session row;
  // surface it so it wins over local pricing-table estimates.
  const reportedCostUsd = Number(session?.cost ?? 0);

  const defaultSource: DataSourceInfo = {
    primary: "sqlite",
    sources: [opencodeDbPath()],
    notes: ["Discovered from opencode SQLite database."],
  };

  return {
    sessionId: session?.id || sessionId,
    slug: session?.slug || sessionId.slice(0, 8),
    title: session?.title || sessionInfo?.title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(allTimestamps),
    turns,
    dataSource: "sqlite",
    dataSourceInfo: defaultSource,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(tokenUsageByModel ? { tokenUsageByModel } : {}),
    ...(Number.isFinite(reportedCostUsd) && reportedCostUsd > 0 ? { reportedCostUsd } : {}),
    compactions: compactions.length > 0 ? compactions : undefined,
    ...(skillsUsed.size > 0 ? { skillsUsed: [...skillsUsed] } : {}),
    ...(skillActivations.length > 0 ? { skillActivations } : {}),
    parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
    ...(truncatedResponses > 0 ? { truncatedResponses } : {}),
  };
}

function userTurnsFromPartsList(parts: OpencodePart[], timestamp?: string): ParsedTurn[] {
  const text = parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
  const images = parts
    .filter((p) => p.type === "file" && p.url && p.mime?.startsWith("image/"))
    .map((p) => p.url as string);

  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  if (images.length > 0) blocks.push({ type: "_user_images", images });

  if (blocks.length === 0) return [];
  return [{ role: "user", timestamp, blocks }];
}

function assistantBlocksFromParts(
  db: Database,
  messageId: string,
  warnings?: NonNullable<ProviderParseResult["parseWarnings"]>,
): ContentBlock[] {
  const parts = partsForMessage(db, messageId, warnings);
  const blocks: ContentBlock[] = [];
  // Running tool parts are placeholder markers; when a completed part for the
  // same callID arrives, remove only that callID's marker so interleaved
  // concurrent tool calls each resolve to their real call with a result.
  const pendingByCallId = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();

  for (const part of parts) {
    switch (part.type) {
      case "reasoning": {
        const thinking = part.text?.trim();
        if (thinking) blocks.push({ type: "thinking", thinking });
        break;
      }
      case "text": {
        const text = part.text || "";
        if (text.trim()) blocks.push({ type: "text", text });
        break;
      }
      case "tool": {
        const toolName = part.tool || "";
        const callID = part.callID || `opencode-${toolName}`;
        const state = part.state || {};
        const input = mapOpencodeToolArgs(toolName, state.input);
        const result = toolResultText(part);
        const isError = state.status === "error";
        const isPending = state.status === "running" || state.status === "pending";
        const hasResult =
          state.status === "completed" ||
          state.status === "error" ||
          (state.status !== "running" && state.status !== "pending" && result.length > 0);
        const durationMs = durationFromState(state.time);

        // A completed tool part supersedes its earlier pending marker: drop the
        // placeholder (by callID) and emit the real call with its result.
        const pendingBlock = pendingByCallId.get(callID);
        if (pendingBlock && !isPending) {
          const idx = blocks.indexOf(pendingBlock);
          if (idx >= 0) blocks.splice(idx, 1);
          pendingByCallId.delete(callID);
        }

        const block: Extract<ContentBlock, { type: "tool_use" }> = {
          type: "tool_use",
          id: callID,
          name: mapOpencodeToolName(toolName),
          input,
          ...(hasResult ? { _hasResult: true, _result: result } : { _hasResult: false }),
          ...(isError ? { _isError: true } : {}),
          ...(isPending ? { _isPendingMarker: true } : {}),
          ...(durationMs ? { _durationMs: durationMs } : {}),
          ...(toolName.toLowerCase() === "skill" &&
          typeof input.name === "string" &&
          input.name.trim()
            ? { _skillName: input.name.trim() }
            : {}),
        };
        blocks.push(block);
        if (isPending) {
          pendingByCallId.set(callID, block);
        }
        break;
      }
      case "compaction": {
        // Handled at the message level below; skip inside block assembly.
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function recordCompaction(
  compactions: Compaction[],
  timestamp: string | undefined,
  part: OpencodePart,
): void {
  if (!timestamp) return;
  // opencode compactions can be auto-triggered or user-requested.
  const auto = part.auto !== false;
  compactions.push({
    timestamp,
    trigger: auto ? "opencode-context" : "opencode-user",
  });
}

function partsForMessage(
  db: Database,
  messageId: string,
  warnings?: NonNullable<ProviderParseResult["parseWarnings"]>,
): OpencodePart[] {
  const rows = rowValues(
    db,
    `
      SELECT message_id, data
      FROM part
      WHERE message_id = ?
      ORDER BY time_created ASC
    `,
    { mid: messageId },
  ) as OpencodePartRow[];

  const parts: OpencodePart[] = [];
  for (const row of rows) {
    if (isUnparseable(row.data)) {
      if (warnings) {
        addParseWarning(warnings, {
          kind: "malformed-json",
          source: "opencode part",
          message: `part ${row.message_id}: unparseable data, skipped`,
          sample: compactWarningSample(row.data),
        });
      }
      continue;
    }
    const parsed = parseMeta<OpencodePart>(row.data);
    if (parsed?.type) parts.push(parsed);
  }
  return parts;
}

function toolResultText(part: OpencodePart): string {
  const state = part.state;
  if (!state) return "";
  const output = state.output || state.metadata?.diff || "";
  return output;
}

function durationFromState(time?: { start?: number; end?: number }): number | undefined {
  if (!time?.start || !time?.end) return undefined;
  const ms = time.end - time.start;
  return ms > 0 ? ms : undefined;
}

function usageFromMeta(tokens: MessageMeta["tokens"]): TokenUsage | undefined {
  if (!tokens) return undefined;
  const usage: TokenUsage = {
    inputTokens: tokens.input || 0,
    outputTokens: tokens.output || 0,
    cacheCreationTokens: tokens.cache?.write || 0,
    cacheReadTokens: tokens.cache?.read || 0,
  };
  return usage;
}

function mergeUsage(map: Map<string, TokenUsage>, model: string, usage: TokenUsage): void {
  const existing = map.get(model);
  if (!existing) {
    map.set(model, { ...usage });
    return;
  }
  existing.inputTokens += usage.inputTokens;
  existing.outputTokens += usage.outputTokens;
  existing.cacheReadTokens += usage.cacheReadTokens;
  existing.cacheCreationTokens += usage.cacheCreationTokens;
}

function mergeUsageTotal(total: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  if (!total) return { ...usage };
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheCreationTokens += usage.cacheCreationTokens;
  return total;
}

function toIsoMs(value?: number): string | undefined {
  if (!value || value <= 0) return undefined;
  const millis = value < 1_577_836_800_000 ? value * 1000 : value;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { opencodeDataDir };
