import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
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
 *
 * `message_parts` may carry `file_ref` parts (`{type:"file_ref", path,
 * mime_type, bytes_len, sha256}`) for user-attached images — paths are
 * relative to the user's home directory and are embedded as data URLs only
 * after a size+sha256 integrity check.
 */

interface MusePart {
  type?: string;
  text?: string;
  /** `file_ref` attachment parts (e.g. user-attached images in `message_parts`). */
  path?: string;
  mime_type?: string;
  bytes_len?: number;
  sha256?: string;
  filename?: string;
}

interface MuseItem {
  type: string;
  role?: string;
  text?: string;
  thinking?: string;
  parts?: Array<MusePart>;
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
  // `created_at` is an ISO string on `item`/`session_header` records, but the
  // runtime writes epoch seconds (number) on `compaction_checkpoint` records.
  created_at?: string | number;
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

/**
 * Embedded images are capped so one giant attachment cannot bloat the
 * replay JSON/HTML the parser feeds.
 */
const MAX_USER_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Cumulative cap across one parse: many individually-valid `file_ref` parts
 * (or the same reference duplicated) must not add up to gigabytes of
 * base64 during parsing or background scanning.
 */
const MAX_TOTAL_USER_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Collect user-attached images from `file_ref` message parts as data URLs.
 *
 * Newer runtimes attach files to user messages as
 * `{type: "file_ref", path, mime_type, bytes_len, sha256}` parts instead of
 * inline text; `textFromItem` drops them, so without this the attachment
 * (and an image-only message entirely) vanishes from the replay.
 *
 * The part's `path` is relative to the user's home directory. A file is
 * only embedded when it resolves inside the home directory (canonical
 * target — symlinks pointing outside are rejected), its size matches a
 * required, bounded `bytes_len`, and its sha256 matches the part's digest —
 * a tampered or swapped file is never silently embedded into a replay.
 * `bytes_len` is required precisely so the embed cap and the size check can
 * be enforced *before* any bytes are read. A shared per-parse byte budget
 * additionally bounds the total embedded across many `file_ref` parts.
 */
function userImageDataUrls(
  item: MuseItem,
  homeDir: string = homedir(),
  budget: { remaining: number } = { remaining: MAX_TOTAL_USER_IMAGE_BYTES },
): string[] {
  const urls: string[] = [];
  if (!Array.isArray(item.parts)) return urls;
  const home = homeDir;
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(home);
  } catch {
    return urls;
  }
  for (const part of item.parts) {
    if (!part || part.type !== "file_ref") continue;
    if (typeof part.mime_type !== "string" || !part.mime_type.startsWith("image/")) continue;
    if (typeof part.path !== "string" || !part.path || typeof part.sha256 !== "string") continue;
    if (
      typeof part.bytes_len !== "number" ||
      !Number.isFinite(part.bytes_len) ||
      part.bytes_len < 0 ||
      part.bytes_len > MAX_USER_IMAGE_BYTES
    ) {
      continue;
    }
    const joined = join(home, part.path);
    if (joined !== home && !joined.startsWith(home + sep)) continue;
    let canonical: string;
    try {
      canonical = realpathSync(joined);
    } catch {
      continue; // missing or unreadable; the text (if any) still replays
    }
    if (canonical !== canonicalHome && !canonical.startsWith(canonicalHome + sep)) continue;
    let size: number;
    try {
      const st = statSync(canonical);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size !== part.bytes_len) continue;
    if (size > budget.remaining) continue;
    let data: Buffer;
    try {
      data = readFileSync(canonical);
    } catch {
      continue;
    }
    if (data.length !== part.bytes_len) continue;
    if (createHash("sha256").update(data).digest("hex") !== part.sha256.toLowerCase()) continue;
    budget.remaining -= data.length;
    urls.push(`data:${part.mime_type};base64,${data.toString("base64")}`);
  }
  return urls;
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

/**
 * Normalize a record's `created_at` to an ISO string. `item` and
 * `session_header` records carry ISO strings, but `compaction_checkpoint`
 * records carry epoch seconds as a number — passing that through would put a
 * raw number into `compactions[].timestamp` / `endTime` and poison the
 * session duration math.
 */
export function normalizeRecordTimestamp(record: { created_at?: unknown }): string | undefined {
  const raw = record.created_at;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
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
  options: {
    sessionInfo?: SessionInfo;
    now?: () => string;
    model?: string;
    homeDir?: string;
    maxTotalImageBytes?: number;
  } = {},
): ProviderParseResult {
  const {
    sessionInfo,
    now = () => new Date().toISOString(),
    model,
    homeDir,
    maxTotalImageBytes = MAX_TOTAL_USER_IMAGE_BYTES,
  } = options;
  const turns: ParsedTurn[] = [];
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  const compactions: Compaction[] = [];
  const timestamps: string[] = [];
  // Shared across the whole parse so many file_ref parts cannot add up to
  // gigabytes of embedded base64.
  const imageBudget = { remaining: maxTotalImageBytes };

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
      const headerTimestamp = normalizeRecordTimestamp(record);
      if (headerTimestamp) {
        headerCreatedAt = headerTimestamp;
        timestamps.push(headerTimestamp);
      }
      continue;
    }
    if (record.type === "compaction_checkpoint") {
      // The checkpoint timestamp marks when compaction ran (the session was
      // still alive), so it counts toward endTime/duration just like it does
      // for the discovery scan's lastTimestamp.
      const checkpointTimestamp = normalizeRecordTimestamp(record) ?? now();
      compactions.push({
        timestamp: checkpointTimestamp,
        trigger: record.trigger ?? "unknown",
      });
      timestamps.push(checkpointTimestamp);
      continue;
    }
    if (record.type !== "item") {
      continue; // forward-compatible: ignore record types we do not understand
    }
    const item = record.item;
    if (!item || typeof item.type !== "string") {
      continue;
    }
    const timestamp = normalizeRecordTimestamp(record);
    if (timestamp) timestamps.push(timestamp);

    switch (item.type) {
      case "message":
      case "message_parts": {
        const text = textFromItem(item);
        if (item.role === "developer") break; // runtime/system instructions stay out of the replay
        if (item.role === "user") {
          flush();
          const cleaned = cleanPromptText(text);
          const images = userImageDataUrls(item, homeDir, imageBudget);
          if (!cleaned && images.length === 0) break;
          const blocks: ContentBlock[] = [];
          if (cleaned) blocks.push({ type: "text", text: cleaned });
          if (images.length > 0) blocks.push({ type: "_user_images", images });
          pushTurn({ role: "user", timestamp, blocks }, recordSource);
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
