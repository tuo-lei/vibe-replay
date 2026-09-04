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
import type { SubAgent, UsageEvent } from "@vibe-replay/types";
import { normalizeSubAgentType } from "@vibe-replay/provider-contract";
import { openOpencodeDb, opencodeDataDir, opencodeDbPath } from "./sqlite.js";
import { attributeOpencodeMcpTool, loadOpencodeMcpServerNames } from "./mcp-servers.js";
import { isOpencodeBuiltinTool, mapOpencodeToolArgs, mapOpencodeToolName } from "./tool-mapping.js";
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
  /** opencode marks model-feeding text parts synthetic; they are not prompts. */
  synthetic?: boolean;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    metadata?: {
      diff?: string;
      /** `task` parts record the spawned child session here. */
      sessionId?: string;
      model?: { modelID?: string; providerID?: string };
    };
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
  /** opencode persists the message's own cost estimate on assistant messages. */
  cost?: number;
  /** Structured failure record present when `finish === "error"`. */
  error?: { name?: string } | string;
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
    return parseSessionFromDb(db, sessionId, sessionInfo, opened.dbPath);
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
  dbPath?: string,
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
  if (!session) {
    throw new Error(`opencode session '${sessionId}' not found`);
  }

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const tokenByModel = new Map<string, TokenUsage>();
  const skillsUsed = new Set<string>();
  const skillActivations: string[] = [];
  const mcpServersUsed = new Set<string>();
  const apiErrors: NonNullable<ProviderParseResult["apiErrors"]> = [];
  /** Per-message usage keyed by message id, consumed by turnStats below. */
  const usageByMessageId = new Map<
    string,
    { usage: TokenUsage; model?: string; contextTokens: number; durationMs?: number }
  >();
  /** `task` call metadata keyed by callID, used to link child sessions. */
  const taskCalls = new Map<string, { sessionId: string; model?: string }>();
  let totalTokens: TokenUsage | undefined;
  let messageCostSum = 0;
  let startTime: string | undefined;
  let endTime: string | undefined;
  const cwd = session?.directory || sessionInfo?.cwd || "";
  let model = sessionInfo?.model;
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  let truncatedResponses = 0;
  // MCP server names come from opencode config files; load at most once per
  // parse and only when an unrecognized tool name shows up.
  let mcpServerNames: string[] | undefined;
  const attributeMcp = (rawToolName: string): { server: string; tool: string } | undefined => {
    if (!rawToolName.includes("_") || isOpencodeBuiltinTool(rawToolName)) return undefined;
    if (mapOpencodeToolName(rawToolName) !== rawToolName) return undefined;
    mcpServerNames ??= loadOpencodeMcpServerNames(cwd);
    const attributed = attributeOpencodeMcpTool(rawToolName, mcpServerNames);
    if (attributed) mcpServersUsed.add(attributed.server);
    return attributed;
  };

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
    if (meta.role === "assistant") {
      const usage = usageFromMeta(meta.tokens);
      if (usage) {
        if (meta.modelID) {
          mergeUsage(tokenByModel, meta.modelID, usage);
        }
        totalTokens = mergeUsageTotal(totalTokens, usage);
        const created = meta.time?.created;
        const completed = meta.time?.completed;
        const durationMs =
          created && completed && completed > created ? completed - created : undefined;
        usageByMessageId.set(message.id, {
          usage,
          ...(meta.modelID ? { model: meta.modelID } : {}),
          contextTokens:
            (meta.tokens?.input || 0) +
            (meta.tokens?.cache?.read || 0) +
            (meta.tokens?.cache?.write || 0),
          ...(durationMs ? { durationMs } : {}),
        });
      }
      if (typeof meta.cost === "number" && Number.isFinite(meta.cost)) {
        messageCostSum += meta.cost;
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
      const blocks = assistantBlocksFromParts(
        db,
        message.id,
        parseWarnings,
        taskCalls,
        attributeMcp,
      );
      if (meta.finish === "error" || meta.finish === "unknown") {
        // Keep concrete tool parts even when the assistant message failed.
        // Previously this branch rendered text only and silently erased failed
        // tool invocations from both the replay and usage index.
        for (const block of blocks) {
          if (block.type === "tool_use" && block._hasResult !== true) {
            block._isError = true;
          }
        }
      }
      if (blocks.length === 0 && meta.finish !== "error") continue;
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block._skillName) continue;
        skillsUsed.add(block._skillName);
        skillActivations.push(block._skillName);
      }
      // opencode (AI SDK) reports truncated generations as finish "length";
      // "max_tokens" is the Anthropic-style spelling kept for safety.
      const isTruncated = meta.finish === "length" || meta.finish === "max_tokens";
      if (isTruncated) truncatedResponses++;
      if (meta.finish === "error" && timestamp) {
        // Privacy: keep only the structured error name (e.g. "APIError"),
        // never the error message text, which may echo prompt content.
        apiErrors.push({ timestamp, ...errorTypeFromMeta(meta.error) });
      }
      if (blocks.length === 0) continue;

      const modelForTurn = meta.modelID || model;
      turns.push({
        role: "assistant",
        messageId: message.id,
        timestamp,
        blocks,
        ...(modelForTurn ? { model: modelForTurn } : {}),
        ...(isTruncated ? { stopReason: "max_tokens" as const } : {}),
      });
      continue;
    }
  }

  const subAgentSummary: NonNullable<ProviderParseResult["subAgentSummary"]> = [];
  if (taskCalls.size > 0) {
    for (const turn of turns) {
      for (const block of turn.blocks) {
        if (block.type !== "tool_use" || block.name !== "Agent") continue;
        const call = taskCalls.get(block.id);
        if (!call) continue;
        const subAgent = buildSubAgentFromChildSession(db, call, block, parseWarnings);
        if (!subAgent) continue;
        block._subAgent = subAgent;
        subAgentSummary.push({
          agentId: subAgent.agentId,
          agentType: subAgent.agentType,
          ...(subAgent.description ? { description: subAgent.description } : {}),
          toolCalls: subAgent.toolCalls,
          ...(subAgent.model ? { model: subAgent.model } : {}),
        });
      }
    }
  }

  const tokenUsage = totalTokens;
  const tokenUsageByModel =
    tokenByModel.size > 0 ? Object.fromEntries(tokenByModel.entries()) : undefined;

  // opencode persists its own cumulative cost estimate on the session row;
  // surface it so it wins over local pricing-table estimates. Versions that
  // leave the session column at 0 still price each assistant message, so fall
  // back to summing those per-message costs.
  const sessionCost = Number(session?.cost ?? 0);
  const reportedCostUsd =
    sessionCost > 0 ? sessionCost : messageCostSum > 0 ? messageCostSum : undefined;

  const turnStats = buildOpencodeTurnStats(turns, usageByMessageId);

  const defaultSource: DataSourceInfo = {
    primary: "sqlite",
    sources: [dbPath ?? opencodeDbPath()],
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
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
    compactions: compactions.length > 0 ? compactions : undefined,
    ...(turnStats.length > 0 ? { turnStats } : {}),
    ...(skillsUsed.size > 0 ? { skillsUsed: [...skillsUsed] } : {}),
    ...(skillActivations.length > 0 ? { skillActivations } : {}),
    ...(mcpServersUsed.size > 0 ? { mcpServersUsed: [...mcpServersUsed].sort() } : {}),
    ...(subAgentSummary.length > 0 ? { subAgentSummary } : {}),
    ...(apiErrors.length > 0 ? { apiErrors } : {}),
    parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
    ...(truncatedResponses > 0 ? { truncatedResponses } : {}),
  };
}

function userTurnsFromPartsList(parts: OpencodePart[], timestamp?: string): ParsedTurn[] {
  const text = parts
    .filter((p) => p.type === "text" && p.text && p.synthetic !== true)
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

/** opencode error records keep a structured `name`; everything else is text we never store. */
function errorTypeFromMeta(error: MessageMeta["error"]): { errorType?: string } {
  const name = typeof error === "object" && error ? error.name : undefined;
  if (typeof name !== "string") return {};
  const trimmed = name.trim();
  // Error names are short identifiers ("APIError", "ProviderAuthError"); a
  // value with whitespace or prose-like length is a message, not a type.
  if (!trimmed || trimmed.length > 64 || /\s/.test(trimmed)) return {};
  return { errorType: trimmed };
}

function assistantBlocksFromParts(
  db: Database,
  messageId: string,
  warnings?: NonNullable<ProviderParseResult["parseWarnings"]>,
  taskCalls?: Map<string, { sessionId: string; model?: string }>,
  attributeMcp?: (rawToolName: string) => { server: string; tool: string } | undefined,
): ContentBlock[] {
  const parts = partsForMessage(db, messageId, warnings);
  const blocks: ContentBlock[] = [];
  // Running tool parts are placeholder markers; when a completed part for the
  // same callID arrives, remove only that callID's marker so interleaved
  // concurrent tool calls each resolve to their real call with a result.
  const pendingByCallId = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();
  const blockByCallId = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();

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

        const existingBlock = blockByCallId.get(callID);
        if (existingBlock && isPending) {
          // Streaming can emit several running snapshots for one call. Keep
          // one logical invocation and wait for its terminal state.
          continue;
        }
        if (existingBlock && !isPending) {
          // A terminal update supersedes either a pending marker or an older
          // terminal snapshot for the same call ID.
          const existingIndex = blocks.indexOf(existingBlock);
          if (existingIndex >= 0) blocks.splice(existingIndex, 1);
          blockByCallId.delete(callID);
          pendingByCallId.delete(callID);
        }

        // A completed tool part supersedes its earlier pending marker: drop the
        // placeholder (by callID) and emit the real call with its result.
        const pendingBlock = pendingByCallId.get(callID);
        if (pendingBlock && !isPending) {
          const idx = blocks.indexOf(pendingBlock);
          if (idx >= 0) blocks.splice(idx, 1);
          pendingByCallId.delete(callID);
        }

        const mcp = attributeMcp?.(toolName);
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
          ...(mcp ? { _mcpServer: mcp.server, _mcpTool: mcp.tool } : {}),
        };
        blocks.push(block);
        blockByCallId.set(callID, block);
        if (isPending) {
          pendingByCallId.set(callID, block);
        }
        // Task tool results carry the spawned child session id in metadata;
        // record it so the caller can attach the subagent trajectory after the
        // main message loop.
        if (toolName === "task" && taskCalls && !isPending) {
          const childId = state.metadata?.sessionId;
          if (typeof childId === "string" && childId) {
            const childModel = state.metadata?.model?.modelID;
            taskCalls.set(callID, {
              sessionId: childId,
              ...(typeof childModel === "string" && childModel ? { model: childModel } : {}),
            });
          }
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

/** Scene capping mirrors the Claude provider so large child traces stay bounded. */
const SUBAGENT_MAX_SCENES = 60;
const SUBAGENT_PROMPT_CHARS = 500;
const SUBAGENT_TEXT_CHARS = 1000;
const SUBAGENT_THINKING_CHARS = 500;

/**
 * opencode spawns subagents as separate session rows linked by `parent_id`;
 * the parent's `task` part records the child id in `state.metadata.sessionId`.
 * Parse the child session into the shared SubAgent shape so replays render the
 * delegated trajectory like other providers. Child `task` calls are parsed as
 * ordinary tool blocks; nesting is not expanded so one bad link can never
 * recurse through the whole database.
 */
function buildSubAgentFromChildSession(
  db: Database,
  call: { sessionId: string; model?: string },
  block: Extract<ContentBlock, { type: "tool_use" }>,
  warnings: NonNullable<ProviderParseResult["parseWarnings"]>,
): SubAgent | undefined {
  const childMessages = rowValues(
    db,
    `
      SELECT id, session_id, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `,
    { sid: call.sessionId },
  ) as OpencodeMessageRow[];
  if (childMessages.length === 0) return undefined;

  const agentType = normalizeSubAgentType(
    typeof block.input?.subagent_type === "string" && block.input.subagent_type.trim()
      ? block.input.subagent_type
      : "unknown",
  );
  const description =
    typeof block.input?.description === "string" && block.input.description.trim()
      ? block.input.description
      : undefined;
  const prompt =
    typeof block.input?.prompt === "string"
      ? block.input.prompt.slice(0, SUBAGENT_PROMPT_CHARS)
      : "";

  let toolCalls = 0;
  let thinkingBlocks = 0;
  let textResponses = 0;
  let model = call.model;
  let tokenUsage: TokenUsage | undefined;
  const usageEvents: UsageEvent[] = [];
  const scenes: SubAgent["scenes"] = [];

  for (const message of childMessages) {
    if (isUnparseable(message.data)) {
      addParseWarning(warnings, {
        kind: "malformed-json",
        source: "opencode message",
        message: `message ${message.id}: unparseable data, skipped`,
        sample: compactWarningSample(message.data),
      });
      continue;
    }
    const meta = parseMeta<MessageMeta>(message.data);
    if (!meta || meta.role !== "assistant") continue;
    const ts = toIsoMs(meta.time?.completed || meta.time?.created);
    if (!model && meta.modelID) model = meta.modelID;
    const usage = usageFromMeta(meta.tokens);
    if (usage) tokenUsage = tokenUsage ? mergeUsageTotal(tokenUsage, usage) : { ...usage };

    // Deliberately no taskCalls collection: nested subagent calls remain
    // ordinary tool blocks instead of recursing into deeper sessions.
    for (const childBlock of assistantBlocksFromParts(db, message.id, warnings)) {
      if (childBlock.type === "thinking") {
        thinkingBlocks++;
        scenes.push({
          type: "thinking",
          content: childBlock.thinking.slice(0, SUBAGENT_THINKING_CHARS),
          ...(ts ? { timestamp: ts } : {}),
        });
      } else if (childBlock.type === "text") {
        textResponses++;
        scenes.push({
          type: "text-response",
          content: childBlock.text.slice(0, SUBAGENT_TEXT_CHARS),
          timestamp: ts,
        });
      } else if (childBlock.type === "tool_use") {
        if (childBlock._isPendingMarker) continue;
        toolCalls++;
        const status = childBlock._isError
          ? ("error" as const)
          : childBlock._hasResult
            ? ("success" as const)
            : ("unknown" as const);
        usageEvents.push({
          kind: "tool",
          name: childBlock.name,
          ...(ts ? { timestamp: ts } : {}),
          ...(childBlock._durationMs ? { durationMs: childBlock._durationMs } : {}),
          status,
          ...(childBlock._mcpServer ? { mcpServer: childBlock._mcpServer } : {}),
          ...(childBlock._mcpTool ? { mcpTool: childBlock._mcpTool } : {}),
          attribution: "explicit",
        });
        scenes.push({
          type: "tool-call",
          toolName: childBlock.name,
          input: childBlock.input,
          result: (childBlock._result || "").slice(0, SUBAGENT_TEXT_CHARS),
          ...(childBlock._hasResult !== undefined ? { hasResult: childBlock._hasResult } : {}),
          isError: childBlock._isError || false,
          ...(ts ? { timestamp: ts } : {}),
          ...(childBlock._durationMs ? { durationMs: childBlock._durationMs } : {}),
        });
      }
    }
  }

  return {
    agentId: call.sessionId,
    agentType,
    ...(description ? { description } : {}),
    prompt,
    toolCalls,
    thinkingBlocks,
    textResponses,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(model ? { model } : {}),
    scenes: scenes.length > SUBAGENT_MAX_SCENES ? scenes.slice(0, SUBAGENT_MAX_SCENES) : scenes,
    usageEvents,
  };
}

/**
 * Per-turn metrics joined in the viewer by 0-based user-prompt turnIndex.
 * opencode records token usage and wall-clock timestamps on each assistant
 * message, so one user prompt's stat aggregates every assistant message up to
 * the next prompt. `contextTokens` keeps the largest prompt footprint seen in
 * the turn (provider-reported accounting, not the actual context window).
 */
function buildOpencodeTurnStats(
  turns: ParsedTurn[],
  usageByMessageId: Map<
    string,
    { usage: TokenUsage; model?: string; contextTokens: number; durationMs?: number }
  >,
): NonNullable<ProviderParseResult["turnStats"]> {
  const stats: NonNullable<ProviderParseResult["turnStats"]> = [];
  let current: { turnIndex: number; messageIds: string[] } | undefined;
  let turnIndex = -1;

  const flushCurrent = (): void => {
    if (!current || current.messageIds.length === 0) {
      current = undefined;
      return;
    }
    const usages: TokenUsage[] = [];
    let statModel: string | undefined;
    let contextTokens = 0;
    let durationMs = 0;
    for (const messageId of current.messageIds) {
      const item = usageByMessageId.get(messageId);
      if (!item) continue;
      usages.push(item.usage);
      statModel = statModel || item.model;
      contextTokens = Math.max(contextTokens, item.contextTokens);
      if (item.durationMs) durationMs += item.durationMs;
    }
    const tokenUsage = usages.reduce<TokenUsage | undefined>(
      (total, usage) => (total ? mergeUsageTotal(total, usage) : { ...usage }),
      undefined,
    );
    stats.push({
      turnIndex: current.turnIndex,
      ...(statModel ? { model: statModel } : {}),
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(contextTokens > 0 ? { contextTokens } : {}),
    });
    current = undefined;
  };

  for (const turn of turns) {
    if (turn.role === "user") {
      flushCurrent();
      if (!turn.subtype) turnIndex++;
      continue;
    }
    if (turn.role === "assistant" && turn.messageId && turnIndex >= 0) {
      current ??= { turnIndex, messageIds: [] };
      current.messageIds.push(turn.messageId);
    }
  }
  flushCurrent();
  return stats;
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
