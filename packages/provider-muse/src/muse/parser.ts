import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type {
  Compaction,
  ContentBlock,
  ParsedTurn,
  ProviderParseResult,
  SessionInfo,
} from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import { getMuseAgentsDir, readMuseSessionMeta } from "./config.js";
import { mapMuseToolArgs, mapMuseToolName } from "./tool-mapping.js";

/**
 * Muse agent transcript layout (per agent):
 *   <agentsRoot>/<agentId>/sessions/<agentId>.jsonl
 *
 * One JSON object per line:
 * - `{"type":"session_header", ...}` — session metadata, exactly once
 * - `{"type":"item", "seq":N, "item":{...}, "created_at":...}` — transcript items
 * - `{"type":"compaction_checkpoint", "compaction_id":N, "trigger":..., "summary":...}`
 *
 * Item kinds: message (user|assistant|developer), message_parts, thinking,
 * function_call, function_call_output, commentary_text.
 */

interface MuseItem {
  type: string;
  role?: string;
  text?: string;
  thinking?: string;
  parts?: Array<{ type?: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  success?: boolean;
}

interface MuseRecord {
  type: string;
  seq?: number;
  source?: string;
  created_at?: string;
  session_id?: string;
  agent_id?: string;
  item?: MuseItem;
  compaction_id?: number;
  trigger?: string;
  summary?: string;
}

type MuseToolBlock = Extract<ContentBlock, { type: "tool_use" }>;

const TITLE_MAX_LENGTH = 80;

/**
 * The runtime labels every injected message with its origin (`runtime.feed`,
 * `runtime.self_improvement`, `scheduler.cron`, `runtime.monitoring`, ...).
 * A bare `runtime` source means interactive: real user turns and subagent
 * delegations. Dotted `runtime.*` / `scheduler.cron` sources are runtime
 * directives, not user prompts — useless as title/firstPrompt.
 */
export function isRuntimeInjectionSource(source: unknown): boolean {
  return (
    typeof source === "string" && (source === "scheduler.cron" || source.startsWith("runtime."))
  );
}

function textFromItem(item: MuseItem): string {
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.parts)) {
    return item.parts
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  return "";
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function firstTextBlockText(turn: ParsedTurn | undefined): string {
  if (!turn) return "";
  for (const block of turn.blocks) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

/**
 * Convert raw transcript lines into normalized turns.
 *
 * - user messages (message / message_parts) → user text turns
 * - assistant messages + commentary_text → assistant text blocks
 * - thinking → assistant thinking blocks
 * - function_call → assistant tool_use blocks, matched with the later
 *   function_call_output by call_id (result, error flag)
 * - compaction_checkpoint → compaction metadata (the summary is a full
 *   pre-compaction conversation summary and is intentionally not replayed)
 * - developer messages → skipped (system/runtime instructions, not user content)
 */
export function parseMuseLines(
  lines: string[],
  options: { sessionInfo?: SessionInfo; now?: () => string; model?: string } = {},
): ProviderParseResult {
  const { sessionInfo, now = () => new Date().toISOString(), model } = options;
  const turns: ParsedTurn[] = [];
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  const compactions: Compaction[] = [];
  const timestamps: string[] = [];

  const toolBlocksByCallId = new Map<string, MuseToolBlock>();
  // Parallel to `turns`: the record-level `source` of the line that created
  // each turn, so title derivation can skip runtime-injected prompts.
  const turnSources: Array<string | undefined> = [];

  let current: ParsedTurn | null = null;
  let sessionId = "";
  let headerCreatedAt: string | undefined;

  const pushTurn = (turn: ParsedTurn, source?: string): void => {
    turns.push(turn);
    turnSources.push(source);
  };

  const ensureAssistantTurn = (timestamp?: string, source?: string): ParsedTurn => {
    if (!current || current.role !== "assistant") {
      current = { role: "assistant", blocks: [], timestamp };
      pushTurn(current, source);
    } else if (timestamp && !current.timestamp) {
      current.timestamp = timestamp;
    }
    return current;
  };

  const flush = (): void => {
    current = null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let record: MuseRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      record = parsed as MuseRecord;
    } catch {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        message: "Skipped a malformed JSON line",
        source: sessionInfo?.filePath ?? "muse",
        firstLine: lineIndex + 1,
      });
      continue;
    }
    const recordSource = typeof record.source === "string" ? record.source : undefined;
    if (record.type === "session_header") {
      if (typeof record.session_id === "string") sessionId = record.session_id;
      if (typeof record.created_at === "string") {
        headerCreatedAt = record.created_at;
        timestamps.push(record.created_at);
      }
      continue;
    }
    if (record.type === "compaction_checkpoint") {
      compactions.push({
        timestamp: record.created_at ?? now(),
        trigger: record.trigger ?? "unknown",
      });
      continue;
    }
    if (record.type !== "item") {
      continue; // forward-compatible: ignore record types we do not understand
    }
    const item = record.item;
    if (!item || typeof item.type !== "string") {
      continue;
    }
    const timestamp = typeof record.created_at === "string" ? record.created_at : undefined;
    if (timestamp) timestamps.push(timestamp);

    switch (item.type) {
      case "message":
      case "message_parts": {
        const text = textFromItem(item);
        if (item.role === "developer") break; // runtime/system instructions stay out of the replay
        if (item.role === "user") {
          flush();
          const cleaned = cleanPromptText(text);
          if (!cleaned) break;
          pushTurn(
            { role: "user", timestamp, blocks: [{ type: "text", text: cleaned }] },
            recordSource,
          );
          break;
        }
        if (!text.trim()) break;
        ensureAssistantTurn(timestamp, recordSource).blocks.push({ type: "text", text });
        break;
      }
      case "commentary_text": {
        const text = typeof item.text === "string" ? item.text : "";
        if (!text.trim()) break;
        ensureAssistantTurn(timestamp, recordSource).blocks.push({ type: "text", text });
        break;
      }
      case "thinking": {
        const thinking = typeof item.thinking === "string" ? item.thinking : "";
        if (!thinking.trim()) break;
        ensureAssistantTurn(timestamp, recordSource).blocks.push({ type: "thinking", thinking });
        break;
      }
      case "function_call": {
        const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
        const rawName = typeof item.name === "string" && item.name ? item.name : "unknown";
        const block: MuseToolBlock = {
          type: "tool_use",
          id: callId ?? `muse-call-${lineIndex}`,
          name: mapMuseToolName(rawName),
          input: mapMuseToolArgs(rawName, parseJsonObject(item.arguments)),
        };
        ensureAssistantTurn(timestamp, recordSource).blocks.push(block);
        if (callId) toolBlocksByCallId.set(callId, block);
        break;
      }
      case "function_call_output": {
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        const block = callId ? toolBlocksByCallId.get(callId) : undefined;
        if (!block) break; // output for a call we never saw; nothing to attach it to
        block._result = typeof item.output === "string" ? item.output : "";
        block._hasResult = true;
        block._isError = item.success === false;
        break;
      }
      default: {
        break; // forward-compatible: ignore item types we do not understand
      }
    }
  }

  const firstUserTurn = turns.find(
    (turn, index) => turn.role === "user" && !isRuntimeInjectionSource(turnSources[index]),
  );
  const firstUserText = firstTextBlockText(firstUserTurn);
  const startTime = headerCreatedAt ?? timestamps[0];
  const endTime = timestamps[timestamps.length - 1];

  return {
    sessionId: sessionId || sessionInfo?.sessionId || "",
    slug: sessionInfo?.slug || (sessionId ? sessionId.slice(0, 8) : ""),
    title: sessionInfo?.title || firstUserText.slice(0, TITLE_MAX_LENGTH) || undefined,
    cwd: sessionInfo?.cwd ?? "",
    model: model ?? sessionInfo?.model,
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(timestamps),
    turns,
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: [shortenPath(dirname(sessionInfo?.filePath ?? getMuseAgentsDir()))],
    },
    compactions,
    parseWarnings,
  };
}

async function parseMuseFiles(
  filePaths: string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const lines: string[] = [];
  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf-8");
    lines.push(...content.split("\n"));
  }
  const primary = filePaths[0];
  const sessionId = sessionInfo?.sessionId ?? extractHeaderSessionId(lines);
  const meta = await readMuseSessionMeta(dirname(primary), sessionId);
  return parseMuseLines(lines, { sessionInfo, model: meta?.model });
}

/** Find the session id from the first session_header record, without a full parse. */
function extractHeaderSessionId(lines: string[]): string {
  for (const line of lines) {
    if (!line.includes("session_header")) continue;
    try {
      const record = JSON.parse(line) as { type?: string; session_id?: string };
      if (record.type === "session_header" && typeof record.session_id === "string") {
        return record.session_id;
      }
    } catch {
      // keep scanning
    }
  }
  return "";
}

export async function parseMuseSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  return parseMuseFiles(Array.isArray(filePaths) ? filePaths : [filePaths], sessionInfo);
}
