import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { normalizeSubAgentType } from "@vibe-replay/provider-contract";
import type { ContentBlock, ParsedTurn, SessionInfo } from "@vibe-replay/provider-contract";
import type { ProviderParseResult } from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import { getGrokBotTranscriptRoots } from "./config.js";
import {
  formatGroupHeader,
  groupHeaderSignature,
  groupWakeBotNames,
  isHumanGroupSpeaker,
  parseGrokBotGroupWake,
} from "./group-chat.js";
import {
  mergeGrokBotGroupParses,
  resolveGrokBotParsePaths,
  resolveOwnerName,
} from "./group-merge.js";
import { classifyGrokBotUserWake, formatAnsweringHeader, peelGrokBotMetaTag } from "./meta-wake.js";
import {
  mediaPathFromPayload,
  rewriteGrokBotShareableText,
  scrubGrokBotMediaPayload,
} from "./media.js";
import {
  grokBotMcpAttribution,
  grokBotReplayToolName,
  isGrokBotEditTool,
  isGrokBotHiddenTool,
  mapGrokBotToolArgs,
} from "./tool-mapping.js";
import { findSandSubagentId } from "./subagent.js";

export {
  extractGroupMentions,
  formatGroupHeader,
  formatGroupSpeakerMessage,
  groupHeaderSignature,
  groupWakeBotNames,
  humanMessageKey,
  isGrokBotGroupChatPayload,
  isHumanGroupSpeaker,
  normalizeGroupKey,
  parseGrokBotGroupWake,
  sameSpeakerName,
  speakerIdentityKey,
} from "./group-chat.js";
export type {
  GrokBotGroupMessage,
  GrokBotGroupParticipant,
  GrokBotGroupWake,
} from "./group-chat.js";
export {
  assignTurnClocks,
  expandGroupTranscriptPaths,
  mergeDiscoveredGroupSessions,
  mergeGrokBotGroupParses,
} from "./group-merge.js";
export { classifyGrokBotUserWake, parseGrokBotMetaWake, peelGrokBotMetaTag } from "./meta-wake.js";
export type { ClassifiedGrokBotUserWake, GrokBotMetaWake } from "./meta-wake.js";
export { rewriteGrokBotShareableText, scrubGrokBotMediaPayload } from "./media.js";
export { findSandSubagentId } from "./subagent.js";

export const SAND_HIDDEN_PROMPT = "[SAND_HIDDEN_PROMPT]";
const USER_TURN_PREFIX_RE = /^\s*\[t\d+u\]\s*/i;
const SEND_MESSAGE_TOOL = "send_message";
const SAND_SUBAGENT_PREFIX = "sand-subagent-";

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
  subagentId?: string;
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
  const paths = await resolveGrokBotParsePaths(filePaths, sessionInfo);
  if (paths.length <= 1) {
    const sourcePath = paths[0] || (Array.isArray(filePaths) ? filePaths[0] : filePaths);
    const content = sourcePath ? await readFile(sourcePath, "utf-8") : "";
    const ownerName = sourcePath ? await resolveOwnerName(sourcePath, sessionInfo) : undefined;
    const parsed = parseGrokBotLines(content.split("\n"), {
      sourcePath,
      sessionInfo,
      ownerName,
    });
    return attachGrokBotSubAgents(parsed, sourcePath);
  }

  const members = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, "utf-8");
      const ownerName = await resolveOwnerName(path, sessionInfo);
      const parsed = await attachGrokBotSubAgents(
        parseGrokBotLines(content.split("\n"), {
          sourcePath: path,
          ownerName,
        }),
        path,
      );
      return {
        path,
        ownerName: ownerName || parsed.agentName,
        parsed,
      };
    }),
  );
  return mergeGrokBotGroupParses(members, sessionInfo);
}

interface ParseGrokBotLinesOptions {
  sourcePath?: string;
  sessionInfo?: SessionInfo;
  /** Display name of the agent that owns this JSONL (profile or inferred). */
  ownerName?: string;
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
  let ownerName = options.ownerName;

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
        if (!ownerName && groupTurns.ownerName) ownerName = groupTurns.ownerName;
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
        if (text.trim()) blocks.push({ type: "thinking", thinking: text });
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

      if (rawName.toLowerCase() === SEND_MESSAGE_TOOL) {
        const visible = extractSendMessageText(block.input);
        if (visible.trim()) blocks.push({ type: "text", text: visible });
        continue;
      }

      if (isGrokBotHiddenTool(rawName)) continue;

      const mappedInput = mapGrokBotToolArgs(rawName, block.input);
      const childId = result?.subagentId || findSandSubagentId(mappedInput);
      if (childId && !stringField(mappedInput, "sessionId")) {
        mappedInput.sessionId = childId;
      }
      const mcp = grokBotMcpAttribution(rawName, mappedInput);
      const call: ToolCallSite = {
        name: grokBotReplayToolName(rawName, mappedInput),
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
      ...(ownerName ? { speaker: ownerName } : {}),
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
    "Grok Bot JSONL does not record token usage or model IDs in v1.",
    "send_message is promoted to assistant text. communicate_update is a status/memory tool scene, not a user-visible reply.",
    "Assistant text blocks are private scratch and map to thinking scenes; they are not the visible reply.",
    "sand-subagent transcripts stay discoverable as their own sessions; parent `task` calls attach a child-run card when the result names a sibling id.",
    "Group-chat wakes split into a room context-injection, human user turns, and assistant-side turns for other bots. Sibling transcripts that share the room title merge into one timeline.",
    "[routine]/[agent] wakes are context-injection; [inbound] remaining text is a user prompt; answering-question wraps are context-injection; background-task wakes are context-injection.",
    "generate_image / computer_use results keep filePath/screenshotPath and omit embedded imageData. file:// markdown images in send_message are rewritten to a path mention and are not bundled into shareable HTML.",
  ];

  return {
    sessionId,
    slug,
    title,
    cwd,
    ...(ownerName ? { agentName: ownerName } : {}),
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
      "Grok Bot transcripts do not include token usage in v1; private scratch is shown as thinking.",
      ...(sawGroupChat
        ? [
            "Group rooms merge sibling agent JSONLs that share the same title; injected peer wake text is dropped when that peer's transcript is present.",
          ]
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
  const raw = extractSendMessageTextRaw(input, depth);
  return depth === 0 ? rewriteGrokBotShareableText(raw) : raw;
}

function extractSendMessageTextRaw(input: unknown, depth = 0): string {
  if (depth > 6 || input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => extractSendMessageTextRaw(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  const nested = [obj.text, obj.content, obj.message, obj.widgets];
  const parts = nested.map((item) => extractSendMessageTextRaw(item, depth + 1)).filter(Boolean);
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
      const subagentId = findSandSubagentId(block.result ?? block.content);
      results.push({
        name,
        ...(id ? { id } : {}),
        text: formatted.text,
        isError: formatted.isError,
        ...(formatted.timestamp ? { timestamp: formatted.timestamp } : {}),
        ...(subagentId ? { subagentId } : {}),
        used: false,
      });
    }
  }
  return results;
}

function formatToolResult(result: unknown): { text: string; isError: boolean; timestamp?: string } {
  const scrubbed = scrubGrokBotMediaPayload(result);
  if (scrubbed == null) return { text: "", isError: false };
  if (typeof scrubbed === "string") return { text: scrubbed, isError: false };
  if (typeof scrubbed !== "object") return { text: String(scrubbed), isError: false };
  const obj = scrubbed as Record<string, unknown>;
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
  const scrubbed = scrubGrokBotMediaPayload(success);
  if (typeof scrubbed === "string") return scrubbed;
  if (!scrubbed || typeof scrubbed !== "object") return scrubbed == null ? "" : String(scrubbed);
  const obj = scrubbed as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.stdout === "string") return obj.stdout;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.text === "string") return obj.text;
  const mediaPath = mediaPathFromPayload(obj);
  const rest = omitKeys(obj, ["timestamp", "messageId", "message_id"]);
  const remaining = mediaPath
    ? omitKeys(rest, [
        "filePath",
        "file_path",
        "screenshotPath",
        "screenshot_path",
        "imagePath",
        "image_path",
        "path",
      ])
    : rest;
  const omittedNotes = Object.values(remaining).filter(
    (item): item is string => typeof item === "string" && item.startsWith("[omitted "),
  );
  const onlyOmitted =
    Object.keys(remaining).length === 0 ||
    Object.values(remaining).every(
      (item) => typeof item === "string" && item.startsWith("[omitted "),
    );
  if (mediaPath && onlyOmitted) {
    return omittedNotes.length > 0 ? `${mediaPath}\n${omittedNotes[0]}` : mediaPath;
  }
  if (Object.keys(rest).length === 0) return mediaPath || "";
  return formatPayload(rest);
}

function formatPayload(value: unknown): string {
  const scrubbed = scrubGrokBotMediaPayload(value);
  if (scrubbed == null) return "";
  if (typeof scrubbed === "string") return scrubbed;
  if (typeof scrubbed === "number" || typeof scrubbed === "boolean") return String(scrubbed);
  if (typeof scrubbed === "object") {
    const obj = scrubbed as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.reason === "string") return obj.reason;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.content === "string") return obj.content;
  }
  try {
    return JSON.stringify(scrubbed, null, 2);
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

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function namesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const SUBAGENT_MAX_SCENES = 60;
const SUBAGENT_PROMPT_CHARS = 500;
const SUBAGENT_TEXT_CHARS = 1000;
const SUBAGENT_THINKING_CHARS = 500;

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type AttachedSubAgent = NonNullable<ToolUseBlock["_subAgent"]>;

async function attachGrokBotSubAgents(
  parsed: ProviderParseResult,
  sourcePath?: string,
): Promise<ProviderParseResult> {
  if (!sourcePath) return parsed;
  const parentId = basename(sourcePath, ".jsonl");
  if (!parentId || parentId.startsWith(SAND_SUBAGENT_PREFIX)) return parsed;
  const transcriptsRoot = dirname(dirname(sourcePath));
  const summaries: NonNullable<ProviderParseResult["subAgentSummary"]> = [
    ...(parsed.subAgentSummary || []),
  ];

  for (const turn of parsed.turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool_use" || block.name !== "Agent" || block._subAgent) continue;
      const childId = findSandSubagentId(block.input) || findSandSubagentId(block._result);
      if (!childId || childId === parentId) continue;
      const childPath = join(transcriptsRoot, childId, `${childId}.jsonl`);
      const content = await readFile(childPath, "utf-8").catch(() => null);
      if (content == null) continue;
      const child = parseGrokBotLines(content.split("\n"), { sourcePath: childPath });
      const subAgent = subAgentFromParsed(child, block, childId);
      block._subAgent = subAgent;
      summaries.push({
        agentId: subAgent.agentId,
        agentType: subAgent.agentType,
        ...(subAgent.description ? { description: subAgent.description } : {}),
        toolCalls: subAgent.toolCalls,
        ...(subAgent.model ? { model: subAgent.model } : {}),
      });
    }
  }

  if (summaries.length === 0) return parsed;
  return { ...parsed, subAgentSummary: summaries };
}

function subAgentFromParsed(
  child: ProviderParseResult,
  parentBlock: ToolUseBlock,
  childId: string,
): AttachedSubAgent {
  const input = parentBlock.input || {};
  const agentType = normalizeSubAgentType(
    typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type
      : "unknown",
  );
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : undefined;
  const prompt =
    typeof input.prompt === "string" ? input.prompt.slice(0, SUBAGENT_PROMPT_CHARS) : "";

  let toolCalls = 0;
  let thinkingBlocks = 0;
  let textResponses = 0;
  const scenes: AttachedSubAgent["scenes"] = [];

  for (const turn of child.turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.type === "thinking") {
        thinkingBlocks++;
        scenes.push({
          type: "thinking",
          content: block.thinking.slice(0, SUBAGENT_THINKING_CHARS),
          ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
        });
      } else if (block.type === "text") {
        textResponses++;
        scenes.push({
          type: "text-response",
          content: block.text.slice(0, SUBAGENT_TEXT_CHARS),
          ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
        });
      } else if (block.type === "tool_use") {
        toolCalls++;
        scenes.push({
          type: "tool-call",
          toolName: block.name,
          input: block.input,
          result: (block._result || "").slice(0, SUBAGENT_TEXT_CHARS),
          ...(block._hasResult !== undefined ? { hasResult: block._hasResult } : {}),
          isError: block._isError || false,
          ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
          ...(block._durationMs ? { durationMs: block._durationMs } : {}),
        });
      }
    }
  }

  return {
    agentId: childId,
    agentType,
    ...(description ? { description } : {}),
    prompt,
    toolCalls,
    thinkingBlocks,
    textResponses,
    scenes: scenes.length > SUBAGENT_MAX_SCENES ? scenes.slice(0, SUBAGENT_MAX_SCENES) : scenes,
  };
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
        const botNames = groupWakeBotNames(group);
        for (const message of group.messages) {
          if (!message.text.trim()) continue;
          if (!isHumanGroupSpeaker(message.speaker, botNames)) continue;
          promptCount++;
          if (prompts.length < 2) prompts.push(message.text.slice(0, 200));
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
      if (name.toLowerCase() === SEND_MESSAGE_TOOL) continue;
      if (isGrokBotHiddenTool(name)) continue;
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
):
  | { turns: ParsedTurn[]; groupTitle?: string; headerKey?: string; ownerName?: string }
  | undefined {
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
  const botNames = groupWakeBotNames(wake);
  for (const message of wake.messages) {
    if (!message.text.trim()) continue;
    if (isHumanGroupSpeaker(message.speaker, botNames)) {
      turns.push({
        role: "user",
        speaker: message.speaker,
        ...(timestamp ? { timestamp } : {}),
        blocks: [{ type: "text", text: message.text }],
      });
      continue;
    }
    turns.push({
      role: "assistant",
      speaker: message.speaker,
      ...(timestamp ? { timestamp } : {}),
      blocks: [{ type: "text", text: message.text }],
    });
  }
  return {
    turns,
    ...(wake.groupTitle ? { groupTitle: wake.groupTitle } : {}),
    ...(headerKey ? { headerKey } : {}),
    ...(wake.turnRecipient ? { ownerName: wake.turnRecipient } : {}),
  };
}
