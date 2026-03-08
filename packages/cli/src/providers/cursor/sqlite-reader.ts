import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContentBlock, ParsedTurn, SessionInfo } from "../../types.js";
import type { ProviderParseResult } from "../types.js";

const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_STORE_DB_SIZE = 8192;

export function workspaceHash(absolutePath: string): string {
  return createHash("md5").update(absolutePath).digest("hex");
}

export function storeDbPath(workspacePath: string, sessionId: string): string {
  return join(CURSOR_CHATS_DIR, workspaceHash(workspacePath), sessionId, "store.db");
}

function globalStateDbCandidates(): string[] {
  const candidates = [
    join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  return [...new Set(candidates)];
}

async function findGlobalStateDb(): Promise<string | null> {
  for (const candidate of globalStateDbCandidates()) {
    const s = await stat(candidate).catch(() => null);
    if (s?.isFile() && s.size >= MIN_STORE_DB_SIZE) return candidate;
  }
  return null;
}

/**
 * Find the store.db for a session by scanning all workspace hash dirs.
 * Session UUIDs are unique across workspaces, so we can match by UUID alone
 * without needing to correctly decode the workspace path.
 */
async function findStoreDb(sessionId: string): Promise<string | null> {
  let workspaceDirs: string[];
  try {
    workspaceDirs = await readdir(CURSOR_CHATS_DIR);
  } catch {
    return null;
  }
  for (const wsHash of workspaceDirs) {
    const dbPath = join(CURSOR_CHATS_DIR, wsHash, sessionId, "store.db");
    const s = await stat(dbPath).catch(() => null);
    if (s?.isFile()) return dbPath;
  }
  return null;
}

export async function storeDbExists(_workspacePath: string, sessionId: string): Promise<boolean> {
  const dbPath = await findStoreDb(sessionId);
  return dbPath !== null;
}

function valueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function parseJson<T = any>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

async function resolveProjectRootFromPath(rawPath: string): Promise<string | null> {
  const candidate = rawPath
    .replaceAll("\\\\", "/")
    .replace(/\\n.*$/, "")
    .replace(/["']+$/g, "")
    .replace(/[),]+$/g, "");
  if (!candidate.startsWith("/")) return null;

  let current = candidate;
  const initial = await stat(current).catch(() => null);
  if (initial?.isFile()) current = dirname(current);

  let deepestExisting: string | null = null;
  while (current && current !== "/") {
    const dirStat = await stat(current).catch(() => null);
    if (dirStat?.isDirectory()) {
      if (!deepestExisting) deepestExisting = current;
      const gitStat = await stat(join(current, ".git")).catch(() => null);
      if (gitStat) return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return deepestExisting;
}

async function inferProjectFromComposerData(
  rawComposerData: string,
  decodedWorkspacePaths: string[],
): Promise<string> {
  const uniqueDecoded = [...new Set(decodedWorkspacePaths.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const workspacePath of uniqueDecoded) {
    const normalized = workspacePath.replaceAll("\\", "/");
    if (
      rawComposerData.includes(normalized) ||
      rawComposerData.includes(normalized.replace(/^\//, ""))
    ) {
      return workspacePath;
    }
  }

  const matches = rawComposerData.match(/\/(?:Users|home)\/[^"'\s,}{]{1,240}/g) || [];
  for (const match of matches) {
    const resolved = await resolveProjectRootFromPath(match);
    if (resolved) return resolved;
  }
  return "";
}

/**
 * Build reverse map from workspace MD5 hash → decoded project path.
 * Accepts pre-decoded workspace paths from the JSONL discovery phase.
 */
function buildHashToProjectMap(decodedWorkspacePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const decoded of decodedWorkspacePaths) {
    if (!decoded) continue;
    const h = workspaceHash(decoded);
    map.set(h, decoded);
  }
  return map;
}

/**
 * Read lightweight metadata from a store.db without full parsing.
 * Returns null if the DB is empty, corrupt, or has no meta table.
 */
async function readStoreDbMeta(dbPath: string): Promise<ChatMeta | null> {
  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    return null;
  }
  const dbBuffer = await readFile(dbPath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBuffer);
  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;
    const metaHex = metaRows[0].values[0][0] as string;
    return JSON.parse(Buffer.from(metaHex, "hex").toString("utf-8"));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Discover sessions that only exist as SQLite store.db (no JSONL transcripts).
 * This catches devcontainer / SSH-remote sessions where the Cursor server extension
 * runs inside the container and doesn't write JSONL to the host.
 */
export async function discoverSqliteOnlySessions(
  knownSessionIds: Set<string>,
  decodedWorkspacePaths: string[] = [],
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let workspaceHashDirs: string[];
  try {
    workspaceHashDirs = await readdir(CURSOR_CHATS_DIR);
  } catch {
    return sessions;
  }

  const hashToProject = buildHashToProjectMap(decodedWorkspacePaths);

  for (const wsHash of workspaceHashDirs) {
    const wsDir = join(CURSOR_CHATS_DIR, wsHash);
    const wsStat = await stat(wsDir).catch(() => null);
    if (!wsStat?.isDirectory()) continue;

    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(wsDir);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      if (knownSessionIds.has(sessionId)) continue;

      const dbPath = join(wsDir, sessionId, "store.db");
      const dbStat = await stat(dbPath).catch(() => null);
      if (!dbStat?.isFile() || dbStat.size < MIN_STORE_DB_SIZE) continue;

      const meta = await readStoreDbMeta(dbPath);
      if (!meta) continue;

      const project = hashToProject.get(wsHash) || "";
      const firstPrompt = meta.name || "(sqlite-only session)";
      const timestamp = meta.createdAt
        ? new Date(meta.createdAt).toISOString()
        : new Date(dbStat.mtimeMs).toISOString();

      sessions.push({
        provider: "cursor",
        sessionId,
        slug: sessionId.slice(0, 8),
        title: meta.name,
        project: shortenPath(project),
        cwd: project,
        version: "",
        timestamp,
        lineCount: 0,
        fileSize: dbStat.size,
        filePath: dbPath,
        filePaths: [],
        workspacePath: project,
        hasSqlite: true,
        firstPrompt,
      });
    }
  }

  return sessions;
}

export interface GlobalStateDiscoveryResult {
  sessions: SessionInfo[];
  sessionIds: Set<string>;
}

/**
 * Discover sessions from Cursor's globalStorage state.vscdb.
 * This is where devcontainer/remote sessions can keep rich `composerData:*`
 * and `bubbleId:*` payloads even when chat `store.db` files are absent.
 */
export async function discoverGlobalStateOnlySessions(
  knownSessionIds: Set<string>,
  decodedWorkspacePaths: string[] = [],
): Promise<GlobalStateDiscoveryResult> {
  const sessionIds = new Set<string>();
  const sessions: SessionInfo[] = [];
  const unknownProjectSessions: SessionInfo[] = [];

  const dbPath = await findGlobalStateDb();
  if (!dbPath) return { sessions, sessionIds };

  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    return { sessions, sessionIds };
  }

  const dbBuffer = await readFile(dbPath).catch(() => null);
  if (!dbBuffer) return { sessions, sessionIds };

  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBuffer);

  try {
    const rows = db.exec("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
    if (!rows.length || !rows[0].values.length) return { sessions, sessionIds };

    for (const [keyValue, value] of rows[0].values) {
      const key = valueToString(keyValue);
      const sessionId = key.startsWith("composerData:") ? key.slice("composerData:".length) : "";
      if (!SESSION_ID_RE.test(sessionId)) continue;

      sessionIds.add(sessionId);
      if (knownSessionIds.has(sessionId)) continue;

      const rawComposer = valueToString(value);
      const composer = parseJson<Record<string, any>>(rawComposer);
      if (!composer) continue;

      const timestamp =
        toIsoTimestamp(composer.lastUpdatedAt) ||
        toIsoTimestamp(composer.createdAt) ||
        new Date().toISOString();
      const title =
        typeof composer.name === "string" && composer.name.trim()
          ? composer.name.trim()
          : undefined;
      const firstPrompt = title || "(cursor global state session)";
      const headers = Array.isArray(composer.fullConversationHeadersOnly)
        ? composer.fullConversationHeadersOnly
        : [];
      const projectPath = await inferProjectFromComposerData(rawComposer, decodedWorkspacePaths);

      const sessionInfo: SessionInfo = {
        provider: "cursor",
        sessionId,
        slug: sessionId.slice(0, 8),
        title,
        project: projectPath ? shortenPath(projectPath) : "(globalStorage)",
        cwd: projectPath,
        version: "",
        timestamp,
        lineCount: headers.length,
        fileSize: Buffer.byteLength(rawComposer, "utf-8"),
        filePath: `${dbPath}#composerData:${sessionId}`,
        filePaths: [],
        workspacePath: projectPath,
        hasSqlite: true,
        firstPrompt,
      };

      if (projectPath) {
        sessions.push(sessionInfo);
      } else {
        unknownProjectSessions.push(sessionInfo);
      }
    }
  } catch {
    // no-op: ignore malformed db rows and return what we have
  } finally {
    db.close();
  }

  // Keep only the most recent sessions per inferred project.
  const perProjectLimit = 40;
  const byProject = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = session.project;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(session);
  }
  const cappedProjectSessions: SessionInfo[] = [];
  for (const projectSessions of byProject.values()) {
    projectSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    cappedProjectSessions.push(...projectSessions.slice(0, perProjectLimit));
  }

  // Avoid flooding picker with thousands of unknown-history sessions.
  const includeUnknownLimit = decodedWorkspacePaths.length > 0 ? 50 : Number.POSITIVE_INFINITY;
  unknownProjectSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const finalSessions = [
    ...cappedProjectSessions,
    ...unknownProjectSessions.slice(0, includeUnknownLimit),
  ];
  finalSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { sessions: finalSessions, sessionIds };
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

interface ChatMeta {
  agentId: string;
  latestRootBlobId: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
}

interface CursorBlock {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, any>;
  result?: string;
  experimental_content?: any[];
  providerOptions?: any;
  signature?: string;
}

interface CursorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CursorBlock[];
  providerOptions?: any;
}

function extractChildBlobIds(data: Uint8Array): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i < data.length - 33) {
    if (data[i] === 0x0a && data[i + 1] === 0x20) {
      const hex = Buffer.from(data.subarray(i + 2, i + 34)).toString("hex");
      ids.push(hex);
      i += 34;
    } else {
      i++;
    }
  }
  return ids;
}

export async function parseCursorSqlite(
  _workspacePath: string,
  sessionId: string,
): Promise<ProviderParseResult | null> {
  const storeResult = await parseCursorStoreDb(sessionId);
  if (storeResult) return storeResult;
  return parseCursorGlobalStateDb(sessionId);
}

async function parseCursorStoreDb(sessionId: string): Promise<ProviderParseResult | null> {
  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    return null;
  }

  const dbPath = await findStoreDb(sessionId);
  if (!dbPath) return null;

  const dbBuffer = await readFile(dbPath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBuffer);

  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;

    const metaHex = metaRows[0].values[0][0] as string;
    const metaJson: ChatMeta = JSON.parse(Buffer.from(metaHex, "hex").toString("utf-8"));
    const rootId = metaJson.latestRootBlobId;

    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) return null;

    const rootData = rootRows[0].values[0][0] as Uint8Array;
    const childIds = extractChildBlobIds(rootData);
    if (childIds.length === 0) return null;

    const messages: CursorMessage[] = [];
    const stmt = db.prepare("SELECT data FROM blobs WHERE id = ?");
    for (const cid of childIds) {
      stmt.bind([cid]);
      if (stmt.step()) {
        const blobData = stmt.get()[0] as Uint8Array;
        try {
          const text = new TextDecoder().decode(blobData);
          messages.push(JSON.parse(text));
        } catch {
          // binary or corrupted blob, skip
        }
      }
      stmt.reset();
    }
    stmt.free();

    const turns = messagesToTurns(messages);
    const slug = sessionId.slice(0, 8);

    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser?.blocks.find((b) => b.type === "text");
    const title = metaJson.name || (firstText as any)?.text?.slice(0, 80);

    return {
      sessionId,
      slug,
      title,
      cwd: "",
      model: metaJson.lastUsedModel,
      startTime: metaJson.createdAt ? new Date(metaJson.createdAt).toISOString() : undefined,
      turns,
      dataSource: "sqlite",
      dataSourceInfo: {
        primary: "sqlite",
        sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
      },
    };
  } finally {
    db.close();
  }
}

function bubbleTypeToRole(type: unknown): "user" | "assistant" {
  return Number(type) === 1 ? "user" : "assistant";
}

function parseThinking(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
}

function normalizeTurnText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/<\/?user_query>/g, "").trim();
  if (!cleaned || SYSTEM_CONTEXT_RE.test(cleaned)) return "";
  return cleaned;
}

function extractToolResultText(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (!parsed) return value;
    return extractToolResultText(parsed);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => extractToolResultText(v)).filter(Boolean);
    return parts.join("\n");
  }

  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, any>;

  if (typeof obj.output === "string" && obj.output.trim()) {
    const exitCode = Number.isFinite(obj.exitCode) ? `\n[exitCode: ${obj.exitCode}]` : "";
    return obj.output + exitCode;
  }
  if (typeof obj.contents === "string" && obj.contents.trim()) return obj.contents;
  if (typeof obj.markdown === "string" && obj.markdown.trim()) return obj.markdown;

  if (typeof obj.result === "string" && obj.result.trim()) {
    const nested = parseJson(obj.result);
    if (nested) {
      const nestedText = extractToolResultText(nested);
      if (nestedText.trim()) return nestedText;
    }
    return obj.result;
  }

  if (Array.isArray(obj.content)) {
    const textItems = obj.content
      .map((item: any) => (item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean);
    if (textItems.length > 0) return textItems.join("\n");
  }

  return JSON.stringify(obj, null, 2);
}

function parseToolFormerBlock(
  bubbleId: string,
  toolFormerData: Record<string, any>,
): ContentBlock | null {
  const name = typeof toolFormerData.name === "string" ? toolFormerData.name : "";
  if (!name) return null;

  const paramsRaw = parseJson<Record<string, any>>(toolFormerData.params) || {};
  const result = extractToolResultText(toolFormerData.result);

  return {
    type: "tool_use",
    id:
      (typeof toolFormerData.toolCallId === "string" && toolFormerData.toolCallId) ||
      `cursor-bubble-${bubbleId}`,
    name: mapCursorToolName(name),
    input: mapToolArgs(name, paramsRaw),
    _result: result,
  } as any;
}

function bubbleToTurn(bubble: Record<string, any>): ParsedTurn | null {
  const role = bubbleTypeToRole(bubble.type);
  const blocks: ContentBlock[] = [];

  if (role === "user") {
    const text = normalizeTurnText(bubble.text);
    if (text) blocks.push({ type: "text", text });
  } else {
    const thinking = parseThinking(bubble.thinking);
    if (thinking) blocks.push({ type: "thinking", thinking } as ContentBlock);

    const text = normalizeTurnText(bubble.text);
    if (text) blocks.push({ type: "text", text });

    if (bubble.toolFormerData && typeof bubble.toolFormerData === "object") {
      const tool = parseToolFormerBlock(
        typeof bubble.bubbleId === "string" ? bubble.bubbleId : "unknown",
        bubble.toolFormerData,
      );
      if (tool) blocks.push(tool);
    }
  }

  if (blocks.length === 0) return null;
  return {
    role,
    timestamp: toIsoTimestamp(bubble.createdAt),
    blocks,
  };
}

async function parseCursorGlobalStateDb(sessionId: string): Promise<ProviderParseResult | null> {
  const dbPath = await findGlobalStateDb();
  if (!dbPath) return null;

  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    return null;
  }

  const dbBuffer = await readFile(dbPath).catch(() => null);
  if (!dbBuffer) return null;

  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBuffer);

  try {
    const composerRows = db.exec("SELECT value FROM cursorDiskKV WHERE key = ?", [
      `composerData:${sessionId}`,
    ]);
    if (!composerRows.length || !composerRows[0].values.length) return null;

    const rawComposer = valueToString(composerRows[0].values[0][0]);
    const composer = parseJson<Record<string, any>>(rawComposer);
    if (!composer) return null;

    const headers = Array.isArray(composer.fullConversationHeadersOnly)
      ? composer.fullConversationHeadersOnly
      : [];
    if (headers.length === 0) return null;

    const turns: ParsedTurn[] = [];
    const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    for (const header of headers) {
      const bubbleId =
        header && typeof header === "object" && typeof (header as any).bubbleId === "string"
          ? (header as any).bubbleId
          : "";
      if (!bubbleId) continue;

      bubbleStmt.bind([`bubbleId:${sessionId}:${bubbleId}`]);
      if (bubbleStmt.step()) {
        const rawBubble = valueToString(bubbleStmt.get()[0]);
        const bubble = parseJson<Record<string, any>>(rawBubble);
        if (bubble) {
          const turn = bubbleToTurn(bubble);
          if (turn) turns.push(turn);
        }
      }
      bubbleStmt.reset();
    }
    bubbleStmt.free();

    if (turns.length === 0) return null;

    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser?.blocks.find((b) => b.type === "text") as any;
    const inferredProject = await inferProjectFromComposerData(rawComposer, []);
    const modelName =
      composer.modelConfig &&
      typeof composer.modelConfig === "object" &&
      typeof composer.modelConfig.modelName === "string"
        ? composer.modelConfig.modelName
        : undefined;

    return {
      sessionId,
      slug: sessionId.slice(0, 8),
      title:
        (typeof composer.name === "string" && composer.name.trim()) ||
        (firstText?.text as string | undefined)?.slice(0, 80),
      cwd: inferredProject || "",
      model: modelName,
      startTime: toIsoTimestamp(composer.createdAt),
      endTime: toIsoTimestamp(composer.lastUpdatedAt),
      turns,
      dataSource: "global-state",
      dataSourceInfo: {
        primary: "global-state",
        sources: ["cursor/user/globalStorage/state.vscdb"],
        notes: ["cursorDiskKV keys: composerData:* + bubbleId:*"],
      },
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function buildToolResultMap(messages: CursorMessage[]): Map<string, CursorBlock> {
  const map = new Map<string, CursorBlock>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool-result" && block.toolCallId) {
        map.set(block.toolCallId, block);
      }
    }
  }
  return map;
}

function messagesToTurns(messages: CursorMessage[]): ParsedTurn[] {
  const toolResults = buildToolResultMap(messages);
  const turns: ParsedTurn[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "tool") continue;

    if (msg.role === "user") {
      const blocks = parseUserContent(msg.content);
      if (blocks.length > 0) {
        turns.push({ role: "user", blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = parseAssistantContent(msg.content, toolResults);
      if (blocks.length > 0) {
        turns.push({
          role: "assistant",
          blocks,
          model: extractModel(msg),
        });
      }
    }
  }

  return turns;
}

const SYSTEM_CONTEXT_RE = /^<(?:user_info|system_reminder|agent_transcripts|rules|git_status)>/;

function parseUserContent(content: string | CursorBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    if (SYSTEM_CONTEXT_RE.test(content.trim())) return [];
    const cleaned = content.replace(/<\/?user_query>/g, "").trim();
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text) {
      if (SYSTEM_CONTEXT_RE.test(b.text.trim())) continue;
      const cleaned = b.text.replace(/<\/?user_query>/g, "").trim();
      if (cleaned) blocks.push({ type: "text", text: cleaned });
    }
  }
  return blocks;
}

function parseAssistantContent(
  content: string | CursorBlock[] | undefined,
  toolResults: Map<string, CursorBlock>,
): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }

  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "reasoning" && b.text?.trim()) {
      blocks.push({ type: "thinking", thinking: b.text } as ContentBlock);
    } else if (b.type === "text" && b.text?.trim()) {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool-call" && b.toolCallId && b.toolName) {
      const result = toolResults.get(b.toolCallId);
      const toolBlock: any = {
        type: "tool_use",
        id: b.toolCallId,
        name: mapCursorToolName(b.toolName),
        input: mapToolArgs(b.toolName, b.args || {}),
        _result: result?.result || "",
      };
      blocks.push(toolBlock);
    }
  }
  return blocks;
}

function mapCursorToolName(name: string): string {
  const mapping: Record<string, string> = {
    Shell: "Bash",
    run_terminal_command_v2: "Bash",
    Read: "Read",
    ReadFile: "Read",
    read_file_v2: "Read",
    read_lints: "ReadLints",
    Grep: "Grep",
    ripgrep_raw_search: "Grep",
    Glob: "Glob",
    glob_file_search: "Glob",
    StrReplace: "Edit",
    EditFile: "Edit",
    edit_file_v2: "Edit",
    Write: "Write",
    WriteFile: "Write",
    Delete: "Delete",
    delete_file: "Delete",
    Task: "Task",
    task_v2: "Task",
    todo_write: "TodoWrite",
    ask_question: "AskQuestion",
    semantic_search_full: "SemanticSearch",
    web_search: "WebSearch",
    WebFetch: "WebFetch",
    web_fetch: "WebFetch",
  };
  return mapping[name] || name;
}

function mapToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  if (toolName === "Shell" && args.command) {
    return {
      command: args.command,
      ...(args.description ? { description: args.description } : {}),
    };
  }
  if (toolName === "StrReplace" && args.path) {
    return {
      file_path: args.path,
      old_string: args.old_string ?? "",
      new_string: args.new_string ?? "",
    };
  }
  if ((toolName === "Write" || toolName === "WriteFile") && args.path) {
    return { file_path: args.path, content: args.contents ?? args.content ?? "" };
  }
  if ((toolName === "Read" || toolName === "ReadFile") && args.path) {
    return { file_path: args.path };
  }
  if (toolName === "run_terminal_command_v2" && args.command) {
    return {
      command: args.command,
      ...(args.commandDescription ? { description: args.commandDescription } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
    };
  }
  if (toolName === "read_file_v2" && args.targetFile) {
    return { file_path: args.targetFile };
  }
  if (toolName === "edit_file_v2" && args.relativeWorkspacePath) {
    return {
      file_path: args.relativeWorkspacePath,
      new_string: args.streamingContent ?? "",
    };
  }
  if (toolName === "delete_file" && args.relativeWorkspacePath) {
    return { file_path: args.relativeWorkspacePath };
  }
  if (toolName === "glob_file_search") {
    return {
      pattern: args.globPattern ?? "",
      path: args.targetDirectory ?? "",
    };
  }
  if (toolName === "ripgrep_raw_search") {
    return {
      pattern: args.pattern ?? "",
      path: args.path ?? "",
      ...(args.glob ? { glob: args.glob } : {}),
      ...(args.caseInsensitive !== undefined
        ? { case_insensitive: Boolean(args.caseInsensitive) }
        : {}),
    };
  }
  if (toolName === "web_search" && args.searchTerm) {
    return { search_term: args.searchTerm };
  }
  if (toolName === "task_v2") {
    return {
      ...(args.description ? { description: args.description } : {}),
      ...(args.prompt ? { prompt: args.prompt } : {}),
      ...(args.subagentType ? { subagent_type: args.subagentType } : {}),
    };
  }
  if (toolName.startsWith("mcp-") && Array.isArray(args.tools) && args.tools.length > 0) {
    const first = args.tools[0] || {};
    const parsedParameters =
      typeof first.parameters === "string"
        ? (parseJson(first.parameters) ?? first.parameters)
        : first.parameters;
    return {
      ...(first.serverName ? { server: first.serverName } : {}),
      ...(first.name ? { tool_name: first.name } : {}),
      ...(parsedParameters !== undefined ? { arguments: parsedParameters } : {}),
    };
  }
  return args;
}

function extractModel(msg: CursorMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;
  for (const b of msg.content) {
    const model = b.providerOptions?.cursor?.modelName;
    if (model) return model;
  }
  return undefined;
}
