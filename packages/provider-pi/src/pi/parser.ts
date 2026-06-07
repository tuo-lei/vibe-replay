import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import type { ContentBlock, ParsedTurn, SessionInfo } from "@vibe-replay/provider-contract";
import type { ProviderParseResult, TokenUsage } from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import { getPiSessionsDir, readPiModelContextWindows } from "./config.js";

interface PiHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
}

interface PiEntryBase {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
}

interface PiMessageEntry extends PiEntryBase {
  type: "message";
  message?: PiMessage;
}

interface PiMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  customType?: string;
  display?: boolean;
  details?: unknown;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface PiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface PiTextBlock {
  type: "text";
  text?: string;
}

interface PiImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
}

interface PiThinkingBlock {
  type: "thinking";
  thinking?: string;
}

type PiContentBlock = PiTextBlock | PiImageBlock | PiThinkingBlock | PiToolCallBlock;

interface ToolResultData {
  text: string;
  images: string[];
  isError?: boolean;
  timestamp?: string;
}

interface BranchSelection {
  entries: PiEntryBase[];
  abandonedEntries: number;
}

export async function parsePiSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const allLines: string[] = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    allLines.push(...content.split("\n"));
  }
  return parsePiLines(allLines, {
    sourcePath: paths[0],
    sessionInfo,
    sessionsDir: getPiSessionsDir(),
    modelContextWindows: await readPiModelContextWindows(),
  });
}

interface ParsePiLinesOptions {
  sourcePath?: string;
  sessionInfo?: SessionInfo;
  sessionsDir?: string;
  modelContextWindows?: ReadonlyMap<string, number>;
}

export function parsePiLines(
  lines: string[],
  options: ParsePiLinesOptions = {},
): ProviderParseResult {
  let header: PiHeader | undefined;
  const entries: PiEntryBase[] = [];
  const byId = new Map<string, PiEntryBase>();
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;

    let entry: PiEntryBase | PiHeader;
    try {
      entry = JSON.parse(line) as PiEntryBase | PiHeader;
    } catch {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        source: "pi JSONL",
        firstLine: lineIndex + 1,
        message: "Skipped malformed JSONL line",
        sample: line,
      });
      continue;
    }

    if (entry.type === "session") {
      if (!header && typeof (entry as PiHeader).id === "string") {
        header = entry as PiHeader;
      }
      continue;
    }

    entries.push(entry);
    if (entry.id) byId.set(entry.id, entry);
  }

  const branchSelection = selectActiveBranch(entries, byId);
  const branchEntries = branchSelection.entries;
  const toolResults = collectToolResults(branchEntries);
  const turns: ParsedTurn[] = [];
  const usageByMessageId = new Map<
    string,
    { usage: TokenUsage; model?: string; contextTokens?: number }
  >();
  const allTimestamps: string[] = [];
  const compactions: NonNullable<ProviderParseResult["compactions"]> = [];
  const apiErrors: NonNullable<ProviderParseResult["apiErrors"]> = [];
  let title = options.sessionInfo?.title;
  let model: string | undefined = options.sessionInfo?.model;
  let currentModel: string | undefined = model;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const entry of branchEntries) {
    if (entry.timestamp) {
      allTimestamps.push(entry.timestamp);
      if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
      if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
    }

    if (entry.type === "session_info") {
      const sessionInfoEntry = entry as PiEntryBase & { name?: unknown };
      const name = typeof sessionInfoEntry.name === "string" ? sessionInfoEntry.name.trim() : "";
      title = name || title;
      continue;
    }

    if (entry.type === "model_change") {
      const nextModel = (entry as { modelId?: unknown }).modelId;
      if (typeof nextModel === "string" && nextModel) {
        currentModel = nextModel;
        model = model || nextModel;
      }
      continue;
    }

    if (entry.type === "compaction") {
      const compaction = entry as { summary?: unknown; tokensBefore?: unknown; timestamp?: string };
      const summary = typeof compaction.summary === "string" ? compaction.summary : "";
      if (summary) {
        turns.push({
          role: "user",
          subtype: "compaction-summary",
          timestamp: entry.timestamp,
          blocks: [{ type: "text", text: summary }],
        });
      }
      compactions.push({
        timestamp: entry.timestamp || lastTimestamp || new Date().toISOString(),
        trigger: "pi",
        ...(typeof compaction.tokensBefore === "number"
          ? { preTokens: compaction.tokensBefore }
          : {}),
      });
      continue;
    }

    if (entry.type === "branch_summary") {
      const summary = (entry as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim()) {
        turns.push({
          role: "user",
          subtype: "context-injection",
          timestamp: entry.timestamp,
          blocks: [{ type: "text", text: `Branch summary:\n${summary}` }],
        });
      }
      continue;
    }

    if (entry.type === "custom_message") {
      const custom = entry as { customType?: unknown; content?: unknown; display?: unknown };
      const text = extractText(custom.content).trim();
      if (text && custom.display !== false) {
        const customType = typeof custom.customType === "string" ? custom.customType : "custom";
        turns.push({
          role: "user",
          subtype: "context-injection",
          timestamp: entry.timestamp,
          blocks: [{ type: "text", text: `[${customType}]\n${text}` }],
        });
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const messageEntry = entry as PiMessageEntry;
    const message = messageEntry.message;
    if (!message) continue;

    if (message.role === "user") {
      const blocks = buildUserBlocks(message.content);
      if (blocks.length > 0) {
        turns.push({ role: "user", timestamp: entry.timestamp, blocks });
      }
      continue;
    }

    if (message.role === "assistant") {
      const blocks = buildAssistantBlocks(message.content, toolResults, entry.timestamp);
      if (message.errorMessage) {
        blocks.push({ type: "text", text: message.errorMessage });
        apiErrors.push({
          timestamp: entry.timestamp || new Date().toISOString(),
          ...parseApiErrorMessage(message.errorMessage),
        });
      }
      if (blocks.length > 0) {
        const msgModel = message.model || currentModel;
        if (msgModel) model = model || msgModel;
        if (message.usage && entry.id) {
          const usage = normalizeUsage(message.usage);
          usageByMessageId.set(entry.id, {
            usage,
            model: msgModel,
            contextTokens: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
          });
        }
        turns.push({
          role: "assistant",
          messageId: entry.id,
          model: msgModel,
          timestamp: entry.timestamp,
          blocks,
          ...(message.stopReason === "length" ? { stopReason: "max_tokens" as const } : {}),
        });
      }
      continue;
    }

    if (message.role === "bashExecution") {
      const block = buildBashExecutionBlock(message, entry.id || `bash-${turns.length}`);
      turns.push({ role: "assistant", timestamp: entry.timestamp, blocks: [block] });
    }
  }

  const tokenUsage = aggregateUsage([...usageByMessageId.values()].map((value) => value.usage));
  const tokenUsageByModel = aggregateUsageByModel(usageByMessageId);
  const turnStats = buildTurnStats(turns, usageByMessageId);
  const sessionId = header?.id || options.sessionInfo?.sessionId || "pi-session";
  const sourcePath = options.sourcePath || options.sessionInfo?.filePath || "";
  const slug = options.sessionInfo?.slug || basename(sourcePath || sessionId, ".jsonl");
  const cwd = header?.cwd || options.sessionInfo?.cwd || options.sessionInfo?.project || "";

  return {
    sessionId,
    slug,
    title,
    cwd,
    model,
    startTime: firstTimestamp || header?.timestamp,
    endTime: lastTimestamp,
    totalDurationMs: estimateActiveDuration(allTimestamps),
    turns,
    tokenUsage,
    ...(tokenUsageByModel ? { tokenUsageByModel } : {}),
    ...(turnStats.length > 0 ? { turnStats } : {}),
    ...(compactions.length > 0 ? { compactions } : {}),
    ...(apiErrors.length > 0 ? { apiErrors } : {}),
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: [shortenPath(options.sessionsDir || getPiSessionsDir())],
      ...(branchSelection.abandonedEntries > 0
        ? { notes: [`${branchSelection.abandonedEntries} off-branch Pi entries were omitted.`] }
        : {}),
    },
    ...(model ? contextLimitForModel(model, options.modelContextWindows) : {}),
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
  };
}

function parseApiErrorMessage(message: string): { statusCode?: number; errorType?: string } {
  const status = message.match(/\b(\d{3})\b/);
  const errorType = message.match(/"([a-z][a-z0-9_]*error[a-z0-9_]*)"/i);
  return {
    ...(status ? { statusCode: Number(status[1]) } : {}),
    ...(errorType ? { errorType: errorType[1] } : {}),
  };
}

function contextLimitForModel(
  model: string,
  modelContextWindows?: ReadonlyMap<string, number>,
): { contextLimit?: number } {
  const contextLimit = modelContextWindows?.get(model);
  return contextLimit ? { contextLimit } : {};
}

function selectActiveBranch(
  entries: PiEntryBase[],
  byId: Map<string, PiEntryBase>,
): BranchSelection {
  if (entries.length === 0) return { entries: [], abandonedEntries: 0 };
  if (byId.size === 0) return { entries, abandonedEntries: 0 };

  const leaf = entries.toReversed().find((entry) => entry.id && byId.has(entry.id));
  if (!leaf?.id) return { entries, abandonedEntries: 0 };

  const branchIds = new Set<string>();
  const branch: PiEntryBase[] = [];
  const seen = new Set<string>();
  let current: PiEntryBase | undefined = leaf;
  while (current) {
    if (!current.id || seen.has(current.id)) break;
    seen.add(current.id);
    branchIds.add(current.id);
    branch.unshift(current);
    const parentId: string | null | undefined = current.parentId;
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  if (branch.length === 0) return { entries, abandonedEntries: 0 };

  const idlessEntries = entries.filter((entry) => !entry.id);
  if (idlessEntries.length === 0) {
    return { entries: branch, abandonedEntries: Math.max(0, entries.length - branch.length) };
  }

  const selected = new Set<PiEntryBase>(branch);
  const branchWithIdless = entries.filter((entry) => selected.has(entry) || !entry.id);
  return {
    entries: branchWithIdless,
    abandonedEntries: entries.filter((entry) => entry.id && !branchIds.has(entry.id)).length,
  };
}

function collectToolResults(entries: PiEntryBase[]): Map<string, ToolResultData> {
  const results = new Map<string, ToolResultData>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as PiMessageEntry).message;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const { text, images } = extractTextAndImages(message.content);
    results.set(message.toolCallId, {
      text,
      images,
      isError: message.isError,
      timestamp: entry.timestamp,
    });
  }
  return results;
}

function buildUserBlocks(content: unknown): ContentBlock[] {
  const { text, images } = extractTextAndImages(content);
  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text });
  if (images.length > 0) blocks.push({ type: "_user_images", images });
  return blocks;
}

function buildAssistantBlocks(
  content: unknown,
  toolResults: Map<string, ToolResultData>,
  assistantTimestamp?: string,
): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content as PiContentBlock[]) {
    if (block.type === "thinking" && block.thinking?.trim()) {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "text" && block.text?.trim()) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      const result = toolResults.get(block.id);
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: mapToolName(block.name),
        input: normalizeToolInput(block.name, block.arguments || {}),
        _result: result?.text || "",
        ...(result?.images.length ? { _images: result.images } : {}),
        ...(result?.isError ? { _isError: true } : {}),
        ...(assistantTimestamp && result?.timestamp
          ? { _durationMs: toolDurationMs(assistantTimestamp, result.timestamp) }
          : {}),
      });
    }
  }
  return blocks;
}

function toolDurationMs(start: string, end: string): number | undefined {
  const duration = Date.parse(end) - Date.parse(start);
  return duration > 0 && duration < 60 * 60_000 ? duration : undefined;
}

function buildBashExecutionBlock(
  message: PiMessage,
  fallbackId: string,
): Extract<ContentBlock, { type: "tool_use" }> {
  const outputParts = [message.output || ""];
  if (message.cancelled) outputParts.push("\n(command cancelled)");
  if (message.truncated && message.fullOutputPath) {
    outputParts.push(`\n[Output truncated. Full output: ${message.fullOutputPath}]`);
  }
  return {
    type: "tool_use",
    id: fallbackId,
    name: "Bash",
    input: { command: message.command || "" },
    _result: outputParts.join(""),
    ...(message.exitCode !== undefined && message.exitCode !== 0 ? { _isError: true } : {}),
  };
}

function extractTextAndImages(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };

  const text: string[] = [];
  const images: string[] = [];
  for (const block of content as PiContentBlock[]) {
    if (block.type === "text") {
      text.push(block.text || "");
    } else if (block.type === "image" && block.data) {
      images.push(`data:${block.mimeType || "image/png"};base64,${block.data}`);
    }
  }
  return { text: text.join("\n"), images };
}

function extractText(content: unknown): string {
  return extractTextAndImages(content).text;
}

function mapToolName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "bash") return "Bash";
  if (normalized === "read") return "Read";
  if (normalized === "write") return "Write";
  if (normalized === "edit") return "Edit";
  if (normalized === "grep") return "Grep";
  if (normalized === "find") return "Find";
  if (normalized === "ls") return "LS";
  return name;
}

function normalizeToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase();
  if (normalized === "write") {
    return {
      ...input,
      ...(typeof input.path === "string" ? { file_path: input.path } : {}),
    };
  }
  if (normalized === "edit") {
    // Pi's edit tool can carry multiple replacements, but the viewer renders
    // one diff per tool call, so map the first edit as the representative diff.
    const firstEdit = Array.isArray(input.edits) ? input.edits[0] : undefined;
    const edit =
      firstEdit && typeof firstEdit === "object" ? (firstEdit as Record<string, unknown>) : input;
    return {
      ...input,
      ...(typeof input.path === "string" ? { file_path: input.path } : {}),
      ...(typeof edit.oldText === "string" ? { old_string: edit.oldText } : {}),
      ...(typeof edit.newText === "string" ? { new_string: edit.newText } : {}),
    };
  }
  return input;
}

function normalizeUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input || 0,
    outputTokens: usage.output || 0,
    cacheCreationTokens: usage.cacheWrite || 0,
    cacheReadTokens: usage.cacheRead || 0,
  };
}

function aggregateUsage(usages: TokenUsage[]): TokenUsage | undefined {
  if (usages.length === 0) return undefined;
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  );
}

function aggregateUsageByModel(
  usageByMessageId: Map<string, { usage: TokenUsage; model?: string; contextTokens?: number }>,
): Record<string, TokenUsage> | undefined {
  if (usageByMessageId.size === 0) return undefined;
  const result: Record<string, TokenUsage> = {};
  for (const { usage, model } of usageByMessageId.values()) {
    const key = model || "unknown";
    result[key] = aggregateUsage(
      [result[key], usage].filter((value): value is TokenUsage => !!value),
    )!;
  }
  return result;
}

function buildTurnStats(
  turns: ParsedTurn[],
  usageByMessageId: Map<string, { usage: TokenUsage; model?: string; contextTokens?: number }>,
): NonNullable<ProviderParseResult["turnStats"]> {
  const stats: NonNullable<ProviderParseResult["turnStats"]> = [];
  let current: { turnIndex: number; messageIds: string[] } | undefined;
  let turnIndex = -1;

  for (const turn of turns) {
    if (turn.role === "user" && !turn.subtype) {
      if (current && current.messageIds.length > 0)
        stats.push(buildTurnStat(current, usageByMessageId));
      turnIndex++;
      current = { turnIndex, messageIds: [] };
    } else if (turn.role === "assistant" && turn.messageId && current) {
      current.messageIds.push(turn.messageId);
    }
  }

  if (current && current.messageIds.length > 0)
    stats.push(buildTurnStat(current, usageByMessageId));
  return stats;
}

function buildTurnStat(
  turn: { turnIndex: number; messageIds: string[] },
  usageByMessageId: Map<string, { usage: TokenUsage; model?: string; contextTokens?: number }>,
): NonNullable<ProviderParseResult["turnStats"]>[number] {
  const usages: TokenUsage[] = [];
  let model: string | undefined;
  let contextTokens = 0;
  for (const messageId of turn.messageIds) {
    const item = usageByMessageId.get(messageId);
    if (!item) continue;
    usages.push(item.usage);
    model = model || item.model;
    contextTokens = Math.max(contextTokens, item.contextTokens || 0);
  }
  const tokenUsage = aggregateUsage(usages);
  return {
    turnIndex: turn.turnIndex,
    ...(model ? { model } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(contextTokens ? { contextTokens } : {}),
  };
}

function estimateActiveDuration(timestamps: string[]): number | undefined {
  if (timestamps.length < 2) return undefined;
  const sorted = timestamps
    .map((timestamp) => Date.parse(timestamp))
    .filter((timestamp) => !Number.isNaN(timestamp))
    .sort((a, b) => a - b);
  if (sorted.length < 2) return undefined;
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < 30 * 60_000) total += gap;
  }
  return total || undefined;
}
