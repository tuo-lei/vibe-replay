import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import type {
  ContentBlock,
  ParsedTurn,
  SessionDiagnostic,
  SessionInfo,
} from "@vibe-replay/provider-contract";
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
  retryAttempt?: number;
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
  const diagnostics: SessionDiagnostic[] = [];
  let title = options.sessionInfo?.title;
  let model: string | undefined = options.sessionInfo?.model;
  let currentModel: string | undefined = model;
  let currentProvider: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  // Summarization requests are billed on top of the messages they replace, so
  // Pi counts them separately from any assistant message usage.
  const summaryUsages: { usage: TokenUsage; model?: string }[] = [];

  for (const [entryIndex, entry] of branchEntries.entries()) {
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
      const modelChange = entry as { modelId?: unknown; provider?: unknown };
      const nextModel = modelChange.modelId;
      if (typeof nextModel === "string" && nextModel) {
        currentModel = nextModel;
        model = nextModel;
      }
      if (typeof modelChange.provider === "string" && modelChange.provider) {
        currentProvider = modelChange.provider;
      }
      continue;
    }

    if (entry.type === "compaction") {
      const compaction = entry as {
        summary?: unknown;
        tokensBefore?: unknown;
        timestamp?: string;
        fromHook?: unknown;
        details?: unknown;
      };
      const summary = typeof compaction.summary === "string" ? compaction.summary : "";
      if (summary) {
        turns.push({
          role: "user",
          subtype: "compaction-summary",
          timestamp: entry.timestamp,
          blocks: [{ type: "text", text: summary }],
        });
      }
      collectSummaryUsage(entry, currentModel, summaryUsages);
      compactions.push({
        timestamp: entry.timestamp || lastTimestamp || new Date().toISOString(),
        trigger: "pi",
        ...(typeof compaction.tokensBefore === "number"
          ? { preTokens: compaction.tokensBefore }
          : {}),
      });
      diagnostics.push(
        classifySuccessfulCompaction(
          branchEntries,
          entryIndex,
          typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : undefined,
          currentModel,
          currentProvider,
          options.modelContextWindows,
          entry.id,
          compaction.fromHook === true,
          compaction.details,
        ),
      );
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
      collectSummaryUsage(entry, currentModel, summaryUsages);
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
      if (message.provider) currentProvider = message.provider;
      const blocks = buildAssistantBlocks(message.content, toolResults, entry.timestamp);
      if (message.errorMessage) {
        blocks.push({ type: "text", text: message.errorMessage });
        apiErrors.push({
          timestamp: entry.timestamp || new Date().toISOString(),
          ...parseApiErrorMessage(message.errorMessage),
          ...(typeof message.retryAttempt === "number"
            ? { retryAttempt: message.retryAttempt }
            : {}),
        });
      }
      if (message.errorMessage || message.stopReason === "error") {
        const compactionFailure = message.errorMessage
          ? parseCompactionFailure(message.errorMessage)
          : undefined;
        const error = message.errorMessage
          ? parseDiagnosticError(message.errorMessage)
          : { errorType: "assistant_error" };
        diagnostics.push({
          kind: compactionFailure ? "compaction" : "assistant-api-error",
          outcome: "failed",
          timestamp: entry.timestamp || new Date().toISOString(),
          confidence: "exact",
          ...(compactionFailure ? { trigger: compactionFailure.trigger } : {}),
          ...(entry.id ? { entryId: entry.id } : {}),
          ...(message.model || currentModel ? { model: message.model || currentModel } : {}),
          ...(message.provider || currentProvider
            ? { provider: message.provider || currentProvider }
            : {}),
          ...(typeof message.retryAttempt === "number"
            ? { retryAttempt: message.retryAttempt }
            : {}),
          ...error,
          ...(compactionFailure?.evidence ? { evidence: compactionFailure.evidence } : {}),
        });
      }
      if (blocks.length > 0) {
        const msgModel = message.model || currentModel;
        if (msgModel) {
          model = model || msgModel;
          currentModel = msgModel;
        }
        if (message.usage && entry.id && hasValidUsageValues(message.usage)) {
          const usage = normalizeUsage(message.usage);
          if (tokenUsageTotal(usage) > 0) {
            usageByMessageId.set(entry.id, {
              usage,
              model: msgModel,
              contextTokens: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
            });
          }
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

  const messageUsages = [...usageByMessageId.values()].map((value) => ({
    usage: value.usage,
    model: value.model,
  }));
  const tokenUsage = aggregateUsage(
    [...messageUsages, ...summaryUsages].map((value) => value.usage),
  );
  const tokenUsageByModel = aggregateUsageByModel([...messageUsages, ...summaryUsages]);
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
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    diagnosticNotes: piDiagnosticNotes(),
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

function classifySuccessfulCompaction(
  entries: PiEntryBase[],
  entryIndex: number,
  preTokens: number | undefined,
  model: string | undefined,
  provider: string | undefined,
  modelContextWindows: ReadonlyMap<string, number> | undefined,
  entryId: string | undefined,
  fromHook: boolean,
  details: unknown,
): SessionDiagnostic {
  const contextLimit = model ? modelContextWindows?.get(model) : undefined;
  const previousAssistant = previousAssistantEntry(entries, entryIndex);
  const previousMessage = previousAssistant?.message;
  const explicitTrigger = compactionTriggerFromDetails(details);

  if (explicitTrigger) {
    return {
      kind: "compaction",
      outcome: "succeeded",
      timestamp: entries[entryIndex]?.timestamp || new Date().toISOString(),
      confidence: "exact",
      trigger: explicitTrigger.trigger,
      ...(entryId ? { entryId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(contextLimit ? { contextLimit } : {}),
      ...(preTokens !== undefined ? { preTokens } : {}),
      evidence: [explicitTrigger.evidence],
    };
  }

  // Pi's v3 JSONL format does not persist the compaction reason. A preceding
  // length-stopped assistant response is the strongest durable signal that
  // Pi's automatic overflow/threshold path admitted this compaction.
  if (previousMessage?.stopReason === "length") {
    return {
      kind: "compaction",
      outcome: "succeeded",
      timestamp: entries[entryIndex]?.timestamp || new Date().toISOString(),
      confidence: "inferred",
      trigger: "automatic-context",
      ...(entryId ? { entryId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(contextLimit ? { contextLimit } : {}),
      ...(preTokens !== undefined ? { preTokens } : {}),
      evidence: ['Nearest preceding assistant response ended with stopReason "length".'],
    };
  }

  // A context estimate near the configured window is useful corroboration,
  // but is deliberately weaker than an explicit runtime event. In
  // particular, a user may manually compact a large session.
  if (preTokens !== undefined && contextLimit && preTokens >= contextLimit * 0.8) {
    return {
      kind: "compaction",
      outcome: "succeeded",
      timestamp: entries[entryIndex]?.timestamp || new Date().toISOString(),
      confidence: "inferred",
      trigger: "automatic-context",
      ...(entryId ? { entryId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      contextLimit,
      preTokens,
      evidence: [
        `Persisted pre-compaction estimate (${preTokens.toLocaleString("en-US")} tokens) was at least 80% of the configured context window.`,
      ],
    };
  }

  return {
    kind: "compaction",
    outcome: "succeeded",
    timestamp: entries[entryIndex]?.timestamp || new Date().toISOString(),
    confidence: "unknown",
    trigger: "unknown",
    ...(entryId ? { entryId } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    evidence: [
      fromHook
        ? "The persisted compaction entry was supplied by a Pi extension hook; its request trigger is not recorded."
        : "Pi v3 JSONL persisted the completed compaction but not the request trigger.",
    ],
  };
}

function compactionTriggerFromDetails(
  details: unknown,
): { trigger: "manual" | "automatic-context"; evidence: string } | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = details as Record<string, unknown>;
  const reason = value.reason || value.trigger;
  if (reason === "manual") {
    return {
      trigger: "manual",
      evidence: "The persisted compaction details explicitly recorded a manual trigger.",
    };
  }
  if (reason === "threshold" || reason === "overflow" || reason === "automatic") {
    return {
      trigger: "automatic-context",
      evidence: `The persisted compaction details explicitly recorded an automatic ${String(reason)} trigger.`,
    };
  }
  return undefined;
}

function previousAssistantEntry(
  entries: PiEntryBase[],
  entryIndex: number,
): PiMessageEntry | undefined {
  for (let index = entryIndex - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const message = (entry as PiMessageEntry).message;
    if (message?.role === "assistant") return entry as PiMessageEntry;
    // A user message starts a new turn. Do not attribute a later manual
    // compaction to an older length-stopped assistant response.
    if (message?.role === "user") return undefined;
  }
  return undefined;
}

function parseCompactionFailure(message: string):
  | {
      trigger: "manual" | "automatic-context" | "unknown";
      evidence: string[];
    }
  | undefined {
  if (/context overflow recovery failed/i.test(message)) {
    return {
      trigger: "automatic-context",
      evidence: ["Pi persisted an explicit context overflow recovery failure."],
    };
  }
  if (/auto(?:matic)?[- ]compaction failed/i.test(message)) {
    return {
      trigger: "automatic-context",
      evidence: ["Pi persisted an explicit automatic compaction failure."],
    };
  }
  if (/manual[- ]compaction failed/i.test(message)) {
    return {
      trigger: "manual",
      evidence: ["Pi persisted an explicit manual compaction failure."],
    };
  }
  if (
    /\bcompaction failed\b|\bcompaction cancell?ed\b|\bsummarization (?:failed|aborted)\b/i.test(
      message,
    )
  ) {
    return {
      trigger: "unknown",
      evidence: ["Pi persisted an explicit compaction/summarization failure message."],
    };
  }
  return undefined;
}

function parseDiagnosticError(message: string): {
  statusCode?: number;
  errorType?: string;
} {
  const parsed = parseApiErrorMessage(message);
  return {
    ...(parsed.statusCode !== undefined ? { statusCode: parsed.statusCode } : {}),
    errorType: normalizedPiErrorType(message),
  };
}

function normalizedPiErrorType(message: string): string {
  const statusCode = parseApiErrorMessage(message).statusCode;
  if (/context.{0,30}(?:overflow|window)|(?:overflow|window).{0,30}context/i.test(message)) {
    return "context_overflow";
  }
  if (/rate[_ -]?limit|too many requests/i.test(message) || statusCode === 429) {
    return "rate_limit_error";
  }
  if (/timeout|timed out/i.test(message) || statusCode === 408 || statusCode === 504) {
    return "timeout";
  }
  if (/connection|network|fetch failed/i.test(message)) return "connection_error";
  if (
    /overloaded|\b5\d\d\b|server error|no body/i.test(message) ||
    (statusCode !== undefined && statusCode >= 500 && statusCode <= 599)
  ) {
    return "server_error";
  }
  if (/aborted|cancelled|canceled/i.test(message)) return "aborted";
  return "assistant_error";
}

function piDiagnosticNotes(): string[] {
  return [
    "Pi JSONL persists completed compaction entries, but not compaction_start/compaction_end or session_compact_failed lifecycle events.",
    "Pi JSONL also does not persist auto_retry or summarization-retry lifecycle events.",
    "A missing compaction-failure event is inconclusive; ordinary assistant/API errors are not attributed to compaction without explicit evidence.",
  ];
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
      isError: message.isError || failedByExitCode(message.details),
      timestamp: entry.timestamp,
    });
  }
  return results;
}

// Harness tools such as exec_command report failures through the result
// details rather than the isError flag that native Pi tools set.
function failedByExitCode(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const record = details as Record<string, unknown>;
  const exitCode = typeof record.exit_code === "number" ? record.exit_code : record.exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
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
      const rawInput = block.arguments || {};
      const normalizedName = block.name.toLowerCase();
      const skillName =
        normalizedName === "skill" || normalizedName === "skill_view"
          ? ["name", "skill", "skillName", "skill_name", "slug"]
              .map((key) => rawInput[key])
              .find(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              )
          : undefined;
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: mapToolName(block.name, rawInput),
        input: normalizeToolInput(block.name, rawInput),
        _hasResult: result !== undefined,
        ...(result !== undefined ? { _result: result.text } : {}),
        ...(result?.images.length ? { _images: result.images } : {}),
        ...(result?.isError ? { _isError: true } : {}),
        ...(skillName ? { _skillName: skillName.trim() } : {}),
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
    _hasResult: true,
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

function mapToolName(name: string, input: Record<string, unknown>): string {
  const normalized = name.toLowerCase();
  if (normalized === "bash") return "Bash";
  if (normalized === "exec_command" && commandFromInput(input)) return "Bash";
  if (normalized === "read") return "Read";
  if (normalized === "write") return "Write";
  if (normalized === "edit") return "Edit";
  if (normalized === "apply_patch" && patchTextFromInput(input)) return "Edit";
  if (normalized === "grep") return "Grep";
  if (normalized === "find") return "Find";
  if (normalized === "ls") return "LS";
  return name;
}

function normalizeToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase();
  if (normalized === "exec_command") {
    const command = commandFromInput(input);
    if (!command) return input;
    return {
      ...input,
      command,
      ...(typeof input.workdir !== "string" && typeof input.cwd === "string"
        ? { workdir: input.cwd }
        : {}),
      ...(typeof input.workdir !== "string" && typeof input.working_directory === "string"
        ? { workdir: input.working_directory }
        : {}),
    };
  }
  if (normalized === "apply_patch") {
    if (!patchTextFromInput(input)) return input;
    return normalizeApplyPatchInput(input);
  }
  if (normalized === "write") {
    return {
      ...input,
      ...(typeof input.path === "string" ? { file_path: input.path } : {}),
    };
  }
  if (normalized === "edit") {
    // Pi's edit tool can carry multiple replacements while the viewer renders a
    // single diff per tool call, so every replacement is joined into one diff.
    const edits = Array.isArray(input.edits)
      ? input.edits.filter(
          (edit): edit is Record<string, unknown> => !!edit && typeof edit === "object",
        )
      : [];
    const replacements = edits.filter(
      (edit) => typeof edit.oldText === "string" && typeof edit.newText === "string",
    );
    const source = replacements.length > 0 ? replacements : [input];
    const oldText = joinEditSegments(source, "oldText");
    const newText = joinEditSegments(source, "newText");
    return {
      ...input,
      ...(typeof input.path === "string" ? { file_path: input.path } : {}),
      ...(oldText === undefined ? {} : { old_string: oldText }),
      ...(newText === undefined ? {} : { new_string: newText }),
    };
  }
  return input;
}

function joinEditSegments(
  edits: Record<string, unknown>[],
  key: "oldText" | "newText",
): string | undefined {
  const segments = edits
    .map((edit) => edit[key])
    .filter((value): value is string => typeof value === "string");
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function commandFromInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.cmd === "string" && input.cmd) return input.cmd;
  if (typeof input.command === "string" && input.command) return input.command;
  return undefined;
}

function patchTextFromInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.input === "string" && input.input) return input.input;
  if (typeof input.patchText === "string" && input.patchText) return input.patchText;
  if (typeof input.patch === "string" && input.patch) return input.patch;
  return undefined;
}

function normalizeApplyPatchInput(input: Record<string, unknown>): Record<string, unknown> {
  const patch = patchTextFromInput(input) || "";
  if (!patch) return input;

  const markers = [...patch.matchAll(/^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(.+)$/gm)];
  const filePaths = markers
    .map((match) => match[2]?.trim())
    .filter((path): path is string => !!path);
  const firstStart = markers[0]?.index;
  const nextStart = markers[1]?.index;
  const firstSection =
    firstStart === undefined ? patch : patch.slice(firstStart, nextStart ?? patch.length);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = markers[0]?.[1] === "Add" || markers[0]?.[1] === "Delete";
  for (const line of firstSection.split("\n")) {
    if (line.startsWith("*** ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) continue;
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      const shared = line.slice(1);
      oldLines.push(shared);
      newLines.push(shared);
    }
  }

  const normalized = { ...input };
  delete normalized.input;
  delete normalized.patchText;
  return {
    ...normalized,
    patch,
    ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
    ...(filePaths.length > 0 ? { file_paths: filePaths } : {}),
    old_string: oldLines.join("\n"),
    new_string: newLines.join("\n"),
  };
}

function collectSummaryUsage(
  entry: PiEntryBase,
  model: string | undefined,
  target: { usage: TokenUsage; model?: string }[],
): void {
  const usage = (entry as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return;
  const rawUsage = usage as PiUsage;
  if (!hasValidUsageValues(rawUsage)) return;
  const normalized = normalizeUsage(rawUsage);
  if (tokenUsageTotal(normalized) === 0) return;
  target.push({ usage: normalized, ...(model ? { model } : {}) });
}

function normalizeUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: tokenCount(usage.input),
    outputTokens: tokenCount(usage.output),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    cacheReadTokens: tokenCount(usage.cacheRead),
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function hasValidUsageValues(usage: PiUsage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(
    (value) => value === undefined || tokenCount(value) === value,
  );
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
  usages: { usage: TokenUsage; model?: string }[],
): Record<string, TokenUsage> | undefined {
  if (usages.length === 0) return undefined;
  const result: Record<string, TokenUsage> = {};
  for (const { usage, model } of usages) {
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
