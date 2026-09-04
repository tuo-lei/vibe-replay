import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import type { ContentBlock, ParsedTurn, SessionInfo } from "@vibe-replay/provider-contract";
import type { ProviderParseResult } from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import { getGrokBotTranscriptRoots } from "./config.js";
import {
  formatGroupHeader,
  formatGroupSpeakerMessage,
  groupHeaderSignature,
  parseGrokBotGroupWake,
} from "./group-chat.js";
import { classifyGrokBotUserWake, formatAnsweringHeader, peelGrokBotMetaTag } from "./meta-wake.js";
import {
  grokBotMcpAttribution,
  isGrokBotEditTool,
  mapGrokBotToolArgs,
  mapGrokBotToolName,
} from "./tool-mapping.js";

export {
  extractGroupMentions,
  formatGroupHeader,
  formatGroupSpeakerMessage,
  groupHeaderSignature,
  isGrokBotGroupChatPayload,
  parseGrokBotGroupWake,
} from "./group-chat.js";
export type {
  GrokBotGroupMessage,
  GrokBotGroupParticipant,
  GrokBotGroupWake,
} from "./group-chat.js";
export { classifyGrokBotUserWake, parseGrokBotMetaWake, peelGrokBotMetaTag } from "./meta-wake.js";
export type { ClassifiedGrokBotUserWake, GrokBotMetaWake } from "./meta-wake.js";

export const SAND_HIDDEN_PROMPT = "[SAND_HIDDEN_PROMPT]";
const USER_TURN_PREFIX_RE = /^\s*\[t\d+u\]\s*/i;
const SEND_MESSAGE_TOOL = "send_message";
const COMMUNICATE_UPDATE_TOOL = "communicate_update";
const PROMOTED_TEXT_TOOLS = new Set([SEND_MESSAGE_TOOL, COMMUNICATE_UPDATE_TOOL]);

interface GrokBotRecord {
  role?: unknown;
  message?: { content?: unknown; role?: unknown };
  timestamp?: unknown;
}

interface GrokBotBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  tool_use_id?: unknown;
  result?: unknown;
  content?: unknown;
}

interface CollectedResult {
  name: string;
  id?: string;
  text: string;
  isError: boolean;
  timestamp?: string;
  used: boolean;
}

interface ToolCallSite {
  name: string;
  rawName: string;
  id: string;
  input: Record<string, unknown>;
  result?: CollectedResult;
}

export async function parseGrokBotSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const allLines: string[] = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    allLines.push(...content.split("\n"));
  }
  return parseGrokBotLines(allLines, {
    sourcePath: paths[0],
    sessionInfo,
  });
}

interface ParseGrokBotLinesOptions {
  sourcePath?: string;
  sessionInfo?: SessionInfo;
}

export function parseGrokBotLines(
  lines: string[],
  options: ParseGrokBotLinesOptions = {},
): ProviderParseResult {
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  const records: { record: GrokBotRecord; line: number }[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let record: GrokBotRecord;
    try {
      record = JSON.parse(line) as GrokBotRecord;
    } catch {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        source: "grok-bot JSONL",
        firstLine: lineIndex + 1,
        message: "Skipped malformed JSONL line",
        sample: line,
      });
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    records.push({ record, line: lineIndex + 1 });
  }

  const results = collectToolResults(records);
  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  let resultCursor = 0;
  let toolUseIndex = 0;
  let groupTitle: string | undefined;
  let sawGroupChat = false;
  let lastGroupHeaderKey: string | undefined;
  let lastKnownTimestamp: string | undefined;

  const takeResult = (rawName: string, toolCallId?: string): CollectedResult | undefined => {
    if (toolCallId) {
      const byId = results.find((item) => !item.used && item.id === toolCallId);
      if (byId) {
        byId.used = true;
        return byId;
      }
    }
    const byName = results
      .slice(resultCursor)
      .find((item) => !item.used && namesMatch(item.name, rawName));
    if (byName) {
      byName.used = true;
      return byName;
    }
    const next = results.slice(resultCursor).find((item) => !item.used);
    if (!next) return undefined;
    if (next.name && rawName && !namesMatch(next.name, rawName)) return undefined;
    next.used = true;
    return next;
  };

  for (const { record } of records) {
    const role = typeof record.role === "string" ? record.role : undefined;
    if (role === "tool") {
      while (resultCursor < results.length && results[resultCursor].used) resultCursor++;
      continue;
    }

    const content = record.message?.content;
    const recordTs = coerceTimestamp(record.timestamp);

    if (role === "user") {
      const text = stripUserDecorators(extractText(content));
      if (!text || isHiddenPrompt(text)) continue;
      const timestamp = recordTs;
      if (timestamp) {
        allTimestamps.push(timestamp);
        lastKnownTimestamp = timestamp;
      }
      const peeled = peelGrokBotMetaTag(text);
      const groupSource = peeled?.rest || text;
      const groupTurns = turnsFromGroupWake(groupSource, timestamp, lastGroupHeaderKey);
      if (groupTurns) {
        sawGroupChat = true;
        if (groupTurns.groupTitle) groupTitle = groupTurns.groupTitle;
        if (groupTurns.headerKey) lastGroupHeaderKey = groupTurns.headerKey;
        turns.push(...groupTurns.turns);
        continue;
      }
      const classified = classifyGrokBotUserWake(text);
      if (classified) {
        if (classified.kind === "skip") continue;
        if (classified.kind === "context-injection") {
          turns.push({
            role: "user",
            subtype: "context-injection",
            ...(timestamp ? { timestamp } : {}),
            blocks: [{ type: "text", text: classified.text }],
          });
          continue;
        }
        if (classified.label === "answering-question") {
          const header = peeled ? formatAnsweringHeader(peeled.wake) : "";
          if (header) {
            turns.push({
              role: "user",
              subtype: "context-injection",
              ...(timestamp ? { timestamp } : {}),
              blocks: [{ type: "text", text: header }],
            });
          }
        }
        turns.push({
          role: "user",
          ...(timestamp ? { timestamp } : {}),
          blocks: [{ type: "text", text: classified.text }],
        });
        continue;
      }
      turns.push({
        role: "user",
        ...(timestamp ? { timestamp } : {}),
        blocks: [{ type: "text", text }],
      });
      continue;
    }

    if (role !== "assistant") continue;

    const blocks: ContentBlock[] = [];
    let turnTimestamp = recordTs;
    if (recordTs) lastKnownTimestamp = recordTs;
    let durationCursor = recordTs || lastKnownTimestamp;
    for (const block of asBlocks(content)) {
      const type = typeof block.type === "string" ? block.type : "";
      if (type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text.trim()) blocks.push({ type: "text", text });
        continue;
      }
      if (type !== "tool_use") continue;
      const rawName = typeof block.name === "string" ? block.name : "unknown";
      const toolCallId = firstString(block.toolCallId, block.tool_call_id, block.tool_use_id);
      const id = toolCallId || `grok-${rawName}-${toolUseIndex++}`;
      const result = takeResult(rawName, toolCallId);
      const durationStart = durationCursor;
      if (result?.timestamp) {
        allTimestamps.push(result.timestamp);
        lastKnownTimestamp = result.timestamp;
        durationCursor = result.timestamp;
        if (!turnTimestamp) turnTimestamp = result.timestamp;
      }

      if (PROMOTED_TEXT_TOOLS.has(rawName.toLowerCase())) {
        const isStatusUpdate = rawName.toLowerCase() === COMMUNICATE_UPDATE_TOOL;
        if (isStatusUpdate && result?.isError) {
          const call: ToolCallSite = {
            name: mapGrokBotToolName(rawName),
            rawName,
            id,
            input: mapGrokBotToolArgs(rawName, block.input),
            result,
          };
          blocks.push(buildToolUseBlock(call, durationStart));
          continue;
        }
        const visible = isStatusUpdate
          ? extractStatusUpdateText(block.input)
          : extractSendMessageText(block.input);
        if (visible.trim()) blocks.push({ type: "text", text: visible });
        continue;
      }

      const mappedInput = mapGrokBotToolArgs(rawName, block.input);
      const mcp = grokBotMcpAttribution(rawName, mappedInput);
      const call: ToolCallSite = {
        name: mapGrokBotToolName(rawName),
        rawName,
        id,
        input: mappedInput,
        result,
      };
      blocks.push(buildToolUseBlock(call, durationStart, mcp));
    }

    if (blocks.length === 0) continue;
    if (turnTimestamp) allTimestamps.push(turnTimestamp);
    turns.push({
      role: "assistant",
      ...(turnTimestamp ? { timestamp: turnTimestamp } : {}),
      blocks,
    });
  }

  const sourcePath = options.sourcePath || options.sessionInfo?.filePath || "";
  const sessionId =
    options.sessionInfo?.sessionId ||
    (sourcePath ? basename(sourcePath, ".jsonl") : "grok-bot-session");
  const slug = options.sessionInfo?.slug || sessionId;
  const cwd = options.sessionInfo?.cwd || options.sessionInfo?.project || "";
  const title = groupTitle ? `Group: ${groupTitle}` : options.sessionInfo?.title;
  const sorted = [...allTimestamps].sort();
  const startTime = sorted[0] || options.sessionInfo?.timestamp;
  const endTime = sorted[sorted.length - 1] || startTime;
  const roots = getGrokBotTranscriptRoots();
  const notes = [
    "Grok Bot JSONL does not record token usage, thinking blobs, or model IDs in v1.",
    "send_message and successful communicate_update calls are promoted to assistant text; failed communicate_update stays a tool-call scene.",
    "sand-subagent transcripts are indexed as separate sessions.",
    "Group-chat user payloads are split into a room context-injection and per-speaker turns; duplicate room headers and your-turn/wrapping-up cues are dropped.",
    "[routine]/[agent] wakes are context-injection; [inbound] remaining text is a user prompt; answering-question wraps are context-injection.",
  ];

  return {
    sessionId,
    slug,
    title,
    cwd,
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(allTimestamps),
    turns,
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: roots.map((root) => shortenPath(root)),
      notes,
    },
    diagnosticNotes: [
      "Grok Bot transcripts do not include thinking blobs or token usage in v1.",
      ...(sawGroupChat
        ? ["Group-chat sessions stay per-agent; v1 does not merge Eng/GTM timelines into one HTML."]
        : []),
    ],
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
  };
}

export function isHiddenPrompt(text: string): boolean {
  return text.includes(SAND_HIDDEN_PROMPT);
}

export function stripUserDecorators(text: string): string {
  return text.replace(USER_TURN_PREFIX_RE, "").trim();
}

export function extractSendMessageText(input: unknown, depth = 0): string {
  if (depth > 6 || input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => extractSendMessageText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  const nested = [obj.text, obj.content, obj.message, obj.widgets];
  const parts = nested.map((item) => extractSendMessageText(item, depth + 1)).filter(Boolean);
  if (parts.length > 0) return parts.join("\n");
  if (typeof obj.label === "string") return obj.label;
  if (typeof obj.title === "string") return obj.title;
  return "";
}

export function extractStatusUpdateText(input: unknown): string {
  const promoted = extractSendMessageText(input);
  if (promoted.trim()) return promoted;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.update === "string") return obj.update;
  if (typeof obj.status === "string") return obj.status;
  return "";
}

function collectToolResults(records: { record: GrokBotRecord }[]): CollectedResult[] {
  const results: CollectedResult[] = [];
  for (const { record } of records) {
    if (record.role !== "tool") continue;
    for (const block of asBlocks(record.message?.content)) {
      if (block.type !== "tool_result") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const id = firstString(block.toolCallId, block.tool_call_id, block.tool_use_id);
      const formatted = formatToolResult(block.result ?? block.content);
      results.push({
        name,
        ...(id ? { id } : {}),
        text: formatted.text,
        isError: formatted.isError,
        ...(formatted.timestamp ? { timestamp: formatted.timestamp } : {}),
        used: false,
      });
    }
  }
  return results;
}

function formatToolResult(result: unknown): { text: string; isError: boolean; timestamp?: string } {
  if (result == null) return { text: "", isError: false };
  if (typeof result === "string") return { text: result, isError: false };
  if (typeof result !== "object") return { text: String(result), isError: false };
  const obj = result as Record<string, unknown>;
  if ("success" in obj) {
    return {
      text: formatSuccessPayload(obj.success),
      isError: false,
      timestamp: timestampFrom(obj.success),
    };
  }
  if ("failure" in obj) {
    return {
      text: formatPayload(obj.failure),
      isError: true,
      timestamp: timestampFrom(obj.failure),
    };
  }
  if ("rejected" in obj) {
    return {
      text: formatPayload(obj.rejected),
      isError: true,
      timestamp: timestampFrom(obj.rejected),
    };
  }
  if ("error" in obj) {
    return { text: formatPayload(obj.error), isError: true, timestamp: timestampFrom(obj.error) };
  }
  return { text: formatPayload(obj), isError: false, timestamp: timestampFrom(obj) };
}

function formatSuccessPayload(success: unknown): string {
  if (typeof success === "string") return success;
  if (!success || typeof success !== "object") return success == null ? "" : String(success);
  const obj = success as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.stdout === "string") return obj.stdout;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.text === "string") return obj.text;
  const rest = omitKeys(obj, ["timestamp", "messageId", "message_id"]);
  if (Object.keys(rest).length === 0) return "";
  return formatPayload(rest);
}

function formatPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.reason === "string") return obj.reason;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.content === "string") return obj.content;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function timestampFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return coerceTimestamp((value as Record<string, unknown>).timestamp);
}

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const skip = new Set(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!skip.has(key)) out[key] = value;
  }
  return out;
}

function buildToolUseBlock(
  call: ToolCallSite,
  startTimestamp?: string,
  mcp?: { server?: string; tool?: string },
): Extract<ContentBlock, { type: "tool_use" }> {
  const durationMs =
    startTimestamp && call.result?.timestamp
      ? toolDurationMs(startTimestamp, call.result.timestamp)
      : undefined;
  return {
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.input,
    _hasResult: call.result !== undefined,
    ...(call.result !== undefined ? { _result: call.result.text } : {}),
    ...(call.result?.isError ? { _isError: true } : {}),
    ...(durationMs !== undefined
      ? { _durationMs: durationMs, _durationSource: "timestamp" as const }
      : {}),
    ...(mcp?.server ? { _mcpServer: mcp.server } : {}),
    ...(mcp?.tool ? { _mcpTool: mcp.tool } : {}),
  };
}

function toolDurationMs(start: string, end: string): number | undefined {
  const duration = Date.parse(end) - Date.parse(start);
  return duration > 0 && duration < 60 * 60_000 ? duration : undefined;
}

function asBlocks(content: unknown): GrokBotBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is GrokBotBlock => !!block && typeof block === "object" && !Array.isArray(block),
  );
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  return asBlocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export function coerceTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d{13}$/.test(trimmed)) {
    const date = new Date(Number(trimmed));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (/^\d{10}$/.test(trimmed)) {
    const date = new Date(Number(trimmed) * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function namesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function countGrokBotDiscoveryStats(content: string): {
  promptCount: number;
  toolCallCount: number;
  editCountEst: number;
  firstPrompt: string;
  prompts: string[];
  timestamp?: string;
  groupTitle?: string;
  isGroupChat?: boolean;
} {
  const prompts: string[] = [];
  let promptCount = 0;
  let toolCallCount = 0;
  let editCountEst = 0;
  let timestamp: string | undefined;
  let groupTitle: string | undefined;
  let isGroupChat = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: GrokBotRecord;
    try {
      record = JSON.parse(line) as GrokBotRecord;
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const ts = coerceTimestamp(record.timestamp);
    if (ts) timestamp = ts;

    if (record.role === "tool") {
      for (const block of asBlocks(record.message?.content)) {
        if (block.type !== "tool_result") continue;
        const formatted = formatToolResult(block.result ?? block.content);
        if (formatted.timestamp) timestamp = formatted.timestamp;
      }
      continue;
    }

    if (record.role === "user") {
      const text = stripUserDecorators(extractText(record.message?.content));
      if (!text || isHiddenPrompt(text)) continue;
      const peeled = peelGrokBotMetaTag(text);
      const groupSource = peeled?.rest || text;
      const group = parseGrokBotGroupWake(groupSource);
      if (group) {
        isGroupChat = true;
        if (group.groupTitle) groupTitle = group.groupTitle;
        for (const message of group.messages) {
          if (!message.text.trim()) continue;
          promptCount++;
          if (prompts.length < 2) {
            prompts.push(formatGroupSpeakerMessage(message.speaker, message.text).slice(0, 200));
          }
        }
        continue;
      }
      const classified = classifyGrokBotUserWake(text);
      if (classified) {
        if (classified.kind !== "prompt") continue;
        promptCount++;
        if (prompts.length < 2) prompts.push(classified.text.slice(0, 200));
        continue;
      }
      promptCount++;
      if (prompts.length < 2) prompts.push(text.slice(0, 200));
      continue;
    }

    if (record.role !== "assistant") continue;
    for (const block of asBlocks(record.message?.content)) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (PROMOTED_TEXT_TOOLS.has(name.toLowerCase())) continue;
      toolCallCount++;
      if (isGrokBotEditTool(name)) editCountEst++;
    }
  }

  return {
    promptCount,
    toolCallCount,
    editCountEst,
    firstPrompt: prompts[0] || "",
    prompts,
    timestamp,
    ...(groupTitle ? { groupTitle } : {}),
    ...(isGroupChat ? { isGroupChat: true } : {}),
  };
}

function turnsFromGroupWake(
  text: string,
  timestamp?: string,
  lastHeaderKey?: string,
): { turns: ParsedTurn[]; groupTitle?: string; headerKey?: string } | undefined {
  const wake = parseGrokBotGroupWake(text);
  if (!wake) return undefined;
  const turns: ParsedTurn[] = [];
  const headerKey = groupHeaderSignature(wake);
  const header = formatGroupHeader(wake);
  const isDuplicateHeader = !!lastHeaderKey && lastHeaderKey === headerKey;
  if (header.trim() && !isDuplicateHeader) {
    turns.push({
      role: "user",
      subtype: "context-injection",
      ...(timestamp ? { timestamp } : {}),
      blocks: [{ type: "text", text: header }],
    });
  }
  for (const message of wake.messages) {
    if (!message.text.trim()) continue;
    turns.push({
      role: "user",
      ...(timestamp ? { timestamp } : {}),
      blocks: [{ type: "text", text: formatGroupSpeakerMessage(message.speaker, message.text) }],
    });
  }
  return {
    turns,
    ...(wake.groupTitle ? { groupTitle: wake.groupTitle } : {}),
    ...(headerKey ? { headerKey } : {}),
  };
}
