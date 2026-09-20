import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import { FILE_EDIT_TOOLS } from "@vibe-replay/provider-core/utils";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { getMuseAgentsDirs, readMuseSessionMeta } from "./config.js";
import { isRuntimeInjectionSource } from "./parser.js";
import { mapMuseToolName } from "./tool-mapping.js";

const PROMPT_SCAN_LIMIT = 2;
const TITLE_MAX_LENGTH = 80;
const SYSTEM_PROMPT_PREFIX = "[subagent context]";

/** Record shapes we read during the lightweight discovery scan. */
interface MuseScanItem {
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

interface MuseScanState {
  headerFound: boolean;
  sessionId: string;
  firstPrompt: string;
  prompts: string[];
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  compactionCount: number;
  lastTimestamp: string;
  lineCount: number;
}

function newScanState(): MuseScanState {
  return {
    headerFound: false,
    sessionId: "",
    firstPrompt: "",
    prompts: [],
    promptCount: 0,
    toolCallCount: 0,
    editCount: 0,
    compactionCount: 0,
    lastTimestamp: "",
    lineCount: 0,
  };
}

function itemText(item: MuseScanItem | undefined): string {
  if (!item) return "";
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
 * The runtime injects a huge "[Subagent Context]..." blob as the first user
 * message of delegated sessions. It is a real transcript line, but useless as
 * a title or firstPrompt, so discovery skips it for those while still
 * counting the prompt.
 *
 * Background jobs (feed writer, self-improvement, cron workers) label their
 * directives with a dotted `runtime.*` / `scheduler.cron` source. Those are
 * runtime directives rather than user prompts, so they are likewise skipped
 * for title/firstPrompt while still counting toward promptCount.
 */
function usablePromptText(item: MuseScanItem, source: unknown): string {
  if (isRuntimeInjectionSource(source)) return "";
  const text = itemText(item);
  if (!text) return "";
  const cleaned = cleanPromptText(text);
  if (!cleaned) return "";
  if (cleaned.toLowerCase().startsWith(SYSTEM_PROMPT_PREFIX)) return "";
  return cleaned;
}

function scanLine(state: MuseScanState, line: string): void {
  state.lineCount += 1;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    record = parsed as Record<string, unknown>;
  } catch {
    return; // Malformed lines become parser warnings, not discovery failures.
  }
  if (typeof record.created_at === "string") {
    state.lastTimestamp = record.created_at;
  }
  if (record.type === "session_header") {
    state.headerFound = true;
    if (typeof record.session_id === "string") state.sessionId = record.session_id;
    return;
  }
  if (record.type === "compaction_checkpoint") {
    state.compactionCount += 1;
    return;
  }
  if (record.type !== "item") return;
  const item = record.item as MuseScanItem | undefined;
  if (!item || typeof item.type !== "string") return;
  if (item.type === "message" || item.type === "message_parts") {
    if (item.role !== "user") return;
    state.promptCount += 1;
    const prompt = usablePromptText(item, record.source);
    if (prompt && !state.firstPrompt) state.firstPrompt = prompt;
    if (prompt && state.prompts.length < PROMPT_SCAN_LIMIT) state.prompts.push(prompt);
    return;
  }
  if (item.type === "function_call") {
    state.toolCallCount += 1;
    // Canonicalize provider tool names before the edit check so Muse
    // built-ins (`edit`/`write`) count the same way scanner edit analytics do.
    if (typeof item.name === "string" && FILE_EDIT_TOOLS.has(mapMuseToolName(item.name))) {
      state.editCount += 1;
    }
  }
}

async function extractMuseSessionInfo(
  filePath: string,
  sessionsDir: string,
  fileSize: number,
  mtimeMs: number,
  includeUnreplayable: boolean,
): Promise<SessionInfo | null> {
  const state = newScanState();
  try {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) scanLine(state, line);
    }
  } catch {
    return null;
  }
  if (!state.headerFound) return null;
  // A delegated session whose only user message is an injected context blob
  // still has real assistant/tool content worth replaying — only drop
  // sessions with no prompts and no tool calls at all.
  if (!includeUnreplayable && state.promptCount === 0 && state.toolCallCount === 0) return null;

  const sessionId = state.sessionId || filePath;
  const meta = await readMuseSessionMeta(sessionsDir, sessionId);
  const timestamp = meta?.updatedAt || state.lastTimestamp || new Date(mtimeMs).toISOString();

  return {
    provider: "muse",
    sessionId,
    slug: sessionId.slice(0, 8),
    title: state.firstPrompt.slice(0, TITLE_MAX_LENGTH) || undefined,
    project: "Muse",
    cwd: "",
    version: "1",
    timestamp,
    lineCount: state.lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: state.firstPrompt || "",
    prompts: state.prompts,
    promptCount: state.promptCount,
    toolCallCount: state.toolCallCount,
    editCountEst: state.editCount || undefined,
    compactionCount: state.compactionCount,
    model: meta?.model,
    sourceFingerprint: `${mtimeMs}:${fileSize}`,
  };
}

async function discoverMuseSessionsInRoot(
  root: string,
  includeUnreplayable: boolean,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let agentDirs: string[];
  try {
    agentDirs = await readdir(root);
  } catch {
    return sessions;
  }
  for (const agentDir of agentDirs) {
    const sessionsDir = join(root, agentDir, "sessions");
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(sessionsDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) continue;
      const info = await extractMuseSessionInfo(
        filePath,
        sessionsDir,
        fileStat.size,
        fileStat.mtimeMs,
        includeUnreplayable,
      );
      if (info) sessions.push(info);
    }
  }
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/**
 * Scan every agent's sessions directory under the Muse agents root
 * (env `MUSE_AGENTS_DIR`, default `~/agents`).
 */
export async function discoverMuseSessions(
  agentsRoot?: string,
  includeUnreplayable = false,
): Promise<SessionInfo[]> {
  const roots = agentsRoot === undefined ? getMuseAgentsDirs() : [agentsRoot];
  const sessions: SessionInfo[] = [];
  for (const root of roots) {
    sessions.push(...(await discoverMuseSessionsInRoot(root, includeUnreplayable)));
  }
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}
