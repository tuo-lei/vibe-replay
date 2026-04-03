import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CursorSidecars, PrLink, TokenUsage, TurnStat } from "@vibe-replay/types";
import { readFileCache, writeFileCache } from "../../cache.js";
import type { ContentBlock, ParsedTurn, SessionInfo } from "../../types.js";
import type { ProviderParseResult } from "../types.js";
import { sanitizeCursorAssistantText, sanitizeCursorReasoningText } from "./sanitize.js";

const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_STORE_DB_SIZE = 8192;
const MAX_CURSOR_REQUEST_CONTEXT_ROWS = 500;

function createRetryableInit<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return async () => {
    if (!promise) {
      promise = factory().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

const getSqlJs = createRetryableInit(async () => {
  const mod = await import("sql.js");
  return mod.default();
});

interface CachedSqlJsDb {
  dbPath: string;
  db: any;
  size: number;
  mtimeMs: number;
}

interface StoreDbIndexEntry {
  dbPath: string;
  sessionId: string;
  workspaceHash: string;
  size: number;
  mtimeMs: number;
}

interface GlobalStateDiscoveryCache {
  dbPath: string;
  size: number;
  mtimeMs: number;
  decodedPathsHash: string;
  sessions: SessionInfo[];
  sessionIds: string[];
}

let cachedGlobalStateDb: CachedSqlJsDb | null = null;
let cachedStoreDbIndex: Map<string, StoreDbIndexEntry> | null = null;
const resolvedProjectRootCache = new Map<string, Promise<string | null>>();
const GLOBAL_STATE_DISCOVERY_CACHE_PREFIX = "cursor-global-state-discovery-v1";

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

async function openGlobalStateDb(): Promise<CachedSqlJsDb | null> {
  const dbPath = await findGlobalStateDb();
  if (!dbPath) return null;

  const dbStat = await stat(dbPath).catch(() => null);
  if (!dbStat?.isFile() || dbStat.size < MIN_STORE_DB_SIZE) return null;

  if (
    cachedGlobalStateDb &&
    cachedGlobalStateDb.dbPath === dbPath &&
    cachedGlobalStateDb.size === dbStat.size &&
    cachedGlobalStateDb.mtimeMs === dbStat.mtimeMs
  ) {
    return cachedGlobalStateDb;
  }

  let SQL: any;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }

  const dbBuffer = await readFile(dbPath).catch(() => null);
  if (!dbBuffer) return null;

  const db = new SQL.Database(dbBuffer);
  cachedGlobalStateDb?.db.close();
  cachedGlobalStateDb = {
    dbPath,
    db,
    size: dbStat.size,
    mtimeMs: dbStat.mtimeMs,
  };
  return cachedGlobalStateDb;
}

function hasGlobalStateSession(db: any, sessionId: string): boolean {
  const rows = db.exec("SELECT 1 FROM cursorDiskKV WHERE key = ? LIMIT 1", [
    `composerData:${sessionId}`,
  ]);
  return rows.length > 0 && rows[0].values.length > 0;
}

/**
 * Find the store.db for a session by scanning all workspace hash dirs.
 * Session UUIDs are unique across workspaces, so we can match by UUID alone
 * without needing to correctly decode the workspace path.
 */
async function buildStoreDbIndex(): Promise<Map<string, StoreDbIndexEntry>> {
  const index = new Map<string, StoreDbIndexEntry>();
  let workspaceDirs: string[];
  try {
    workspaceDirs = await readdir(CURSOR_CHATS_DIR);
  } catch {
    return index;
  }

  for (const wsHash of workspaceDirs) {
    const wsDir = join(CURSOR_CHATS_DIR, wsHash);
    const wsStat = await stat(wsDir).catch(() => null);
    if (!wsStat?.isDirectory()) continue;

    let sessions: string[];
    try {
      sessions = await readdir(wsDir);
    } catch {
      continue;
    }

    for (const sessionId of sessions) {
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const dbPath = join(wsDir, sessionId, "store.db");
      const dbStat = await stat(dbPath).catch(() => null);
      if (!dbStat?.isFile() || dbStat.size < MIN_STORE_DB_SIZE) continue;
      index.set(sessionId, {
        dbPath,
        sessionId,
        workspaceHash: wsHash,
        size: dbStat.size,
        mtimeMs: dbStat.mtimeMs,
      });
    }
  }

  return index;
}

async function getStoreDbIndex(forceRefresh = false): Promise<Map<string, StoreDbIndexEntry>> {
  if (!forceRefresh && cachedStoreDbIndex) return cachedStoreDbIndex;
  cachedStoreDbIndex = await buildStoreDbIndex();
  return cachedStoreDbIndex;
}

async function findStoreDb(sessionId: string): Promise<string | null> {
  const cached = await getStoreDbIndex();
  if (cached.has(sessionId)) return cached.get(sessionId)?.dbPath || null;
  const refreshed = await getStoreDbIndex(true);
  return refreshed.get(sessionId)?.dbPath || null;
}

export async function storeDbExists(_workspacePath: string, sessionId: string): Promise<boolean> {
  const dbPath = await findStoreDb(sessionId);
  return dbPath !== null;
}

export async function listStoreDbSessionIds(forceRefresh = false): Promise<Set<string>> {
  return new Set((await getStoreDbIndex(forceRefresh)).keys());
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

function toNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 ? Math.round(value) : 0;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return 0;
}

function toPositiveMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const msMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*ms$/i);
    if (msMatch) return Math.round(Number(msMatch[1]));
    const secMatch = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*s(ec(?:onds?)?)?$/i);
    if (secMatch) return Math.round(Number(secMatch[1]) * 1000);
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

function hasAnyTokens(usage: TokenUsage | undefined): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationTokens > 0 ||
    usage.cacheReadTokens > 0
  );
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function addTokenUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
}

function cloneTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
  };
}

function tokenUsageHasDrop(current: TokenUsage, previous: TokenUsage): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.cacheCreationTokens < previous.cacheCreationTokens ||
    current.cacheReadTokens < previous.cacheReadTokens
  );
}

function tokenUsageDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheCreationTokens: Math.max(0, current.cacheCreationTokens - previous.cacheCreationTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
  };
}

function estimateTokenIncrement(
  snapshot: TokenUsage,
  previousSnapshot: TokenUsage | undefined,
): { increment: TokenUsage; nextSnapshot: TokenUsage } {
  if (!previousSnapshot || !hasAnyTokens(previousSnapshot)) {
    return { increment: cloneTokenUsage(snapshot), nextSnapshot: cloneTokenUsage(snapshot) };
  }
  if (tokenUsageHasDrop(snapshot, previousSnapshot)) {
    // Cursor payloads can reset across branches/resumes; treat new snapshot as fresh baseline.
    return { increment: cloneTokenUsage(snapshot), nextSnapshot: cloneTokenUsage(snapshot) };
  }
  return {
    increment: tokenUsageDelta(snapshot, previousSnapshot),
    nextSnapshot: cloneTokenUsage(snapshot),
  };
}

function tokenUsageFromCursorTokenCount(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, any>;
  const usage: TokenUsage = {
    inputTokens: toNonNegativeInt(obj.inputTokens ?? obj.input_tokens),
    outputTokens: toNonNegativeInt(obj.outputTokens ?? obj.output_tokens),
    cacheCreationTokens: toNonNegativeInt(
      obj.cacheCreationTokens ?? obj.cache_creation_input_tokens,
    ),
    cacheReadTokens: toNonNegativeInt(obj.cacheReadTokens ?? obj.cache_read_input_tokens),
  };
  return hasAnyTokens(usage) ? usage : undefined;
}

function hashWorkspacePaths(paths: string[]): string {
  const normalized = [...new Set(paths.filter(Boolean))].sort().join("\n");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

async function resolveProjectRootFromPath(rawPath: string): Promise<string | null> {
  const candidate = rawPath
    .replaceAll("\\\\", "/")
    .replace(/\\n.*$/, "")
    .replace(/["']+$/g, "")
    .replace(/[),]+$/g, "");
  if (!candidate.startsWith("/")) return null;

  const cached = resolvedProjectRootCache.get(candidate);
  if (cached) return cached;

  const resolving = (async () => {
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
  })();

  resolvedProjectRootCache.set(candidate, resolving);
  return resolving;
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

  const hintedRoots = extractComposerProjectRootHints(rawComposerData);
  const basenameMatches = new Map<string, string[]>();
  for (const workspacePath of uniqueDecoded) {
    const key = basename(workspacePath);
    if (!key) continue;
    const existing = basenameMatches.get(key) || [];
    existing.push(workspacePath);
    basenameMatches.set(key, existing);
  }

  const bestHint = hintedRoots.find((hint) => !isLowSignalProjectRoot(hint));
  if (bestHint) {
    const matchingDecoded = basenameMatches.get(basename(bestHint)) || [];
    if (matchingDecoded.length === 1) return matchingDecoded[0];
    if (canUseComposerProjectHintDirectly(bestHint)) return bestHint;
  }

  for (const hint of hintedRoots) {
    const matchingDecoded = basenameMatches.get(basename(hint)) || [];
    if (matchingDecoded.length === 1) return matchingDecoded[0];

    if (canUseComposerProjectHintDirectly(hint)) return hint;

    const resolved = await resolveProjectRootFromPath(hint);
    if (resolved && !isLowSignalProjectRoot(resolved)) return resolved;
  }

  const matches =
    rawComposerData.match(/\/(?:Users|home|workspace|workspaces|tmp)\/[^"'\s,}{]{1,240}/g) || [];
  for (const match of matches) {
    const resolved = await resolveProjectRootFromPath(match);
    if (resolved && !isLowSignalProjectRoot(resolved)) return resolved;
  }
  if (bestHint) return bestHint;
  return "";
}

function extractComposerProjectRootHints(rawComposerData: string): string[] {
  const matches =
    rawComposerData.match(/\/(?:Users|home|workspace|workspaces|tmp)\/[^"'\s,}{]{1,240}/g) || [];
  const roots = matches
    .map((match) => inferProjectRootFromPathHint(match))
    .filter((value): value is string => Boolean(value));
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

function inferProjectRootFromPathHint(pathValue: string): string | null {
  const normalized = pathValue.replaceAll("\\", "/").replace(/[)"',]+$/g, "");
  if (!normalized.startsWith("/")) return null;

  if (
    normalized.includes("/.config/") ||
    normalized.includes("/.cursor/skills/") ||
    normalized.includes("/.cursor/extensions/")
  ) {
    return null;
  }

  const dotMarker = ["/.git/", "/.devcontainer/", "/.cursor/"].find((marker) =>
    normalized.includes(marker),
  );
  if (dotMarker) {
    const root = normalized.slice(0, normalized.indexOf(dotMarker));
    return root || null;
  }

  const workspaceMatch = normalized.match(/^\/(workspace|workspaces)\/([^/]+)/);
  if (workspaceMatch?.[2] && !workspaceMatch[2].startsWith(".")) {
    return `/${workspaceMatch[1]}/${workspaceMatch[2]}`;
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] === "Users" && parts.length >= 4) {
    return `/${parts.slice(0, 4).join("/")}`;
  }
  if (parts[0] === "home" && parts.length >= 3 && !parts[2].startsWith(".")) {
    return `/${parts.slice(0, 3).join("/")}`;
  }
  return null;
}

function isLowSignalProjectRoot(pathValue: string): boolean {
  return (
    pathValue === "/home" ||
    pathValue === "/tmp" ||
    pathValue === "/workspace" ||
    pathValue === "/workspaces" ||
    /^\/home\/[^/]+$/.test(pathValue)
  );
}

function canUseComposerProjectHintDirectly(pathValue: string): boolean {
  return (
    /^\/workspaces\/[^/]+$/.test(pathValue) ||
    /^\/workspace\/[^/]+$/.test(pathValue) ||
    /^\/home\/[^/]+\/[^/]+$/.test(pathValue) ||
    /^\/Users\/[^/]+\/[^/]+\/[^/]+$/.test(pathValue)
  );
}

function hasReplayableRootBlob(data: unknown): boolean {
  if (!(data instanceof Uint8Array) || data.length === 0) return false;
  return extractChildBlobIds(data).length > 0;
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
async function readStoreDbMeta(dbPath: string): Promise<StoreDbMetaPreview | null> {
  let SQL: any;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }
  const dbBuffer = await readFile(dbPath).catch(() => null);
  if (!dbBuffer) return null;
  const db = new SQL.Database(dbBuffer);
  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;
    const metaHex = metaRows[0].values[0][0] as string;
    const meta = JSON.parse(Buffer.from(metaHex, "hex").toString("utf-8")) as ChatMeta;
    const rootId = meta.latestRootBlobId;
    if (!rootId) return { meta, hasReplayableRoot: false };
    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) {
      return { meta, hasReplayableRoot: false };
    }
    const rootData = rootRows[0].values[0][0] as unknown;
    return { meta, hasReplayableRoot: hasReplayableRootBlob(rootData) };
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
  forceRefreshStoreDbIndex = false,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const storeDbIndex = await getStoreDbIndex(forceRefreshStoreDbIndex);
  const hashToProject = buildHashToProjectMap(decodedWorkspacePaths);

  for (const entry of storeDbIndex.values()) {
    if (knownSessionIds.has(entry.sessionId)) continue;

    const metaPreview = await readStoreDbMeta(entry.dbPath);
    if (!metaPreview?.hasReplayableRoot) continue;
    const meta = metaPreview.meta;

    const project = hashToProject.get(entry.workspaceHash) || "";
    const firstPrompt = meta.name || "(sqlite-only session)";
    const timestamp = meta.createdAt
      ? new Date(meta.createdAt).toISOString()
      : new Date(entry.mtimeMs).toISOString();

    sessions.push({
      provider: "cursor",
      sessionId: entry.sessionId,
      slug: entry.sessionId.slice(0, 8),
      title: meta.name,
      project: shortenPath(project),
      cwd: project,
      version: "",
      timestamp,
      lineCount: 0,
      fileSize: entry.size,
      filePath: entry.dbPath,
      filePaths: [],
      workspacePath: project,
      hasSqlite: true,
      firstPrompt,
    });
  }

  return sessions;
}

export interface GlobalStateDiscoveryResult {
  sessions: SessionInfo[];
  sessionIds: Set<string>;
}

export function countComposerConversationHeaders(composer: Record<string, any>): number {
  return Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly.length
    : 0;
}

function finalizeGlobalStateDiscovery(
  discoveredSessions: SessionInfo[],
  knownSessionIds: Set<string>,
  decodedWorkspacePaths: string[],
): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const unknownProjectSessions: SessionInfo[] = [];

  for (const session of discoveredSessions) {
    if (knownSessionIds.has(session.sessionId)) continue;
    if (session.cwd) {
      sessions.push(session);
    } else {
      unknownProjectSessions.push(session);
    }
  }

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

  const includeUnknownLimit = decodedWorkspacePaths.length > 0 ? 50 : Number.POSITIVE_INFINITY;
  unknownProjectSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const finalSessions = [
    ...cappedProjectSessions,
    ...unknownProjectSessions.slice(0, includeUnknownLimit),
  ];
  finalSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return finalSessions;
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
  const globalStateDb = await openGlobalStateDb();
  if (!globalStateDb) return { sessions: [], sessionIds };
  const { dbPath, db } = globalStateDb;
  const decodedPathsHash = hashWorkspacePaths(decodedWorkspacePaths);
  const cacheKey = `${GLOBAL_STATE_DISCOVERY_CACHE_PREFIX}-${decodedPathsHash}`;

  const cached = await readFileCache<GlobalStateDiscoveryCache>(cacheKey);
  if (
    cached?.data.dbPath === dbPath &&
    cached.data.size === globalStateDb.size &&
    cached.data.mtimeMs === globalStateDb.mtimeMs &&
    cached.data.decodedPathsHash === decodedPathsHash
  ) {
    const cachedIds = new Set(cached.data.sessionIds);
    return {
      sessions: finalizeGlobalStateDiscovery(
        cached.data.sessions,
        knownSessionIds,
        decodedWorkspacePaths,
      ),
      sessionIds: cachedIds,
    };
  }

  const discoveredSessions: SessionInfo[] = [];

  try {
    const rows = db.exec("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
    if (!rows.length || !rows[0].values.length) return { sessions: [], sessionIds };

    for (const [keyValue, value] of rows[0].values) {
      const key = valueToString(keyValue);
      const sessionId = key.startsWith("composerData:") ? key.slice("composerData:".length) : "";
      if (!SESSION_ID_RE.test(sessionId)) continue;

      const rawComposer = valueToString(value);
      const composer = parseJson<Record<string, any>>(rawComposer);
      if (!composer) continue;
      const headerCount = countComposerConversationHeaders(composer);
      // Skip sessions without conversation headers: they cannot be replayed.
      if (headerCount === 0) continue;

      // Track only replayable global-state sessions for downstream hasSqlite marking.
      sessionIds.add(sessionId);

      const timestamp =
        toIsoTimestamp(composer.lastUpdatedAt) ||
        toIsoTimestamp(composer.createdAt) ||
        new Date().toISOString();
      const title =
        typeof composer.name === "string" && composer.name.trim()
          ? composer.name.trim()
          : undefined;
      const firstPrompt = title || "(cursor global state session)";
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
        lineCount: headerCount,
        fileSize: Buffer.byteLength(rawComposer, "utf-8"),
        filePath: `${dbPath}#composerData:${sessionId}`,
        filePaths: [],
        workspacePath: projectPath,
        hasSqlite: true,
        firstPrompt,
      };
      discoveredSessions.push(sessionInfo);
    }
  } catch {
    // no-op: ignore malformed db rows and return what we have
  }

  await writeFileCache<GlobalStateDiscoveryCache>(cacheKey, {
    dbPath,
    size: globalStateDb.size,
    mtimeMs: globalStateDb.mtimeMs,
    decodedPathsHash,
    sessions: discoveredSessions,
    sessionIds: [...sessionIds],
  });

  return {
    sessions: finalizeGlobalStateDiscovery(
      discoveredSessions,
      knownSessionIds,
      decodedWorkspacePaths,
    ),
    sessionIds,
  };
}

export async function getCursorSessionCachePaths(sessionId: string): Promise<string[]> {
  const paths: string[] = [];
  const storeDb = await findStoreDb(sessionId);
  if (storeDb) paths.push(storeDb);

  const globalStateDb = await openGlobalStateDb();
  if (globalStateDb && hasGlobalStateSession(globalStateDb.db, sessionId)) {
    paths.push(globalStateDb.dbPath);
  }

  return [...new Set(paths)];
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

interface StoreDbMetaPreview {
  meta: ChatMeta;
  hasReplayableRoot: boolean;
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
  if (storeResult) {
    // sql.js needs the whole DB loaded into memory, so the first global-state probe is expensive.
    // Keep the cheap composer-key existence check below so store-backed sessions avoid the full
    // enrichment parse when they do not actually exist in state.vscdb.
    const globalStateDb = await openGlobalStateDb();
    if (!globalStateDb || !hasGlobalStateSession(globalStateDb.db, sessionId)) {
      return storeResult;
    }
    const globalStateResult = await parseCursorGlobalStateDb(sessionId, globalStateDb);
    return globalStateResult
      ? mergeCursorParseResults(storeResult, globalStateResult)
      : storeResult;
  }
  return parseCursorGlobalStateDb(sessionId);
}

async function parseCursorStoreDb(sessionId: string): Promise<ProviderParseResult | null> {
  let SQL: any;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }

  const dbPath = await findStoreDb(sessionId);
  if (!dbPath) return null;

  const dbBuffer = await readFile(dbPath);
  const db = new SQL.Database(dbBuffer);

  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;

    const metaHex = metaRows[0].values[0][0] as string;
    const metaJson: ChatMeta = JSON.parse(Buffer.from(metaHex, "hex").toString("utf-8"));
    const rootId = metaJson.latestRootBlobId;
    if (!rootId) return null;

    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) return null;

    const rootData = rootRows[0].values[0][0] as Uint8Array;
    const childIds = extractChildBlobIds(rootData);
    if (childIds.length === 0) return null;

    const messages: CursorMessage[] = [];
    const stmt = db.prepare("SELECT data FROM blobs WHERE id = ?");
    for (const cid of childIds) {
      try {
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
      } finally {
        stmt.reset();
      }
    }
    stmt.free();

    const { turns, turnStats, totalDurationMs } = messagesToTurns(messages);
    const slug = sessionId.slice(0, 8);

    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser?.blocks.find((b) => b.type === "text");
    const title = metaJson.name || (firstText as any)?.text?.slice(0, 80);
    const hasDurationStats = turnStats.some((stat) => (stat.durationMs || 0) > 0);

    const notes: string[] = [];
    if (hasDurationStats) {
      notes.push("Per-turn duration is estimated from Cursor tool execution metadata.");
    } else {
      notes.push("Per-turn duration metrics are unavailable for this Cursor SQLite session.");
    }
    notes.push("Token usage is unavailable for this Cursor SQLite session.");

    return {
      sessionId,
      slug,
      title,
      cwd: "",
      model:
        normalizeCursorModelName(metaJson.lastUsedModel) ||
        turnStats.find((stat) => typeof stat.model === "string" && stat.model)?.model,
      startTime: metaJson.createdAt ? new Date(metaJson.createdAt).toISOString() : undefined,
      ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
      ...(turnStats.length > 0 ? { turnStats } : {}),
      turns,
      dataSource: "sqlite",
      dataSourceInfo: {
        primary: "sqlite",
        sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
        notes,
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
  if (typeof value === "string") return sanitizeCursorReasoningText(value);
  if (
    value &&
    typeof value === "object" &&
    "text" in value &&
    typeof (value as { text: unknown }).text === "string"
  ) {
    return sanitizeCursorReasoningText((value as { text: string }).text);
  }
  return "";
}

function normalizeTurnText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/<\/?user_query>/g, "").trim();
  if (!cleaned || CURSOR_SYSTEM_CONTEXT_RE.test(cleaned)) return "";
  return cleaned;
}

function normalizeAssistantTurnText(raw: unknown, hasToolContext: boolean): string {
  const cleaned = normalizeTurnText(raw);
  if (!cleaned) return "";
  return sanitizeCursorAssistantText(cleaned, hasToolContext);
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

function hasToolError(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (!parsed) return false;
    return hasToolError(parsed);
  }
  if (Array.isArray(value)) return value.some((item) => hasToolError(item));
  if (typeof value !== "object") return false;

  const obj = value as Record<string, any>;
  if (obj.isError === true) return true;
  if (obj.failure) return true;
  if (obj.rejected && obj.rejected !== false) return true;
  if (typeof obj.error === "string" && obj.error.trim()) return true;
  if (obj.error === true) return true;
  if (obj.output && typeof obj.output === "object") {
    const output = obj.output as Record<string, any>;
    if (output.failure) return true;
    if (output.success === false) return true;
  }
  return false;
}

function extractToolExecutionTimeMs(value: unknown): number | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed ? extractToolExecutionTimeMs(parsed) : toPositiveMs(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ms = extractToolExecutionTimeMs(item);
      if (ms !== undefined) return ms;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;

  const obj = value as Record<string, any>;
  const direct =
    toPositiveMs(obj.localExecutionTimeMs) ??
    toPositiveMs(obj.executionTimeMs) ??
    toPositiveMs(obj.executionTime);
  if (direct !== undefined) return direct;
  if (obj.output && typeof obj.output === "object") {
    const output = obj.output as Record<string, any>;
    const successMs = extractToolExecutionTimeMs(output.success);
    if (successMs !== undefined) return successMs;
    return extractToolExecutionTimeMs(output.failure);
  }
  return undefined;
}

function parseToolFormerBlock(
  bubbleId: string,
  toolFormerData: Record<string, any>,
): ContentBlock | null {
  const name = typeof toolFormerData.name === "string" ? toolFormerData.name : "";
  if (!name) return null;

  const parsedParams = parseJson<Record<string, any>>(toolFormerData.params);
  const paramsRaw = parsedParams ?? toolFormerData.params ?? {};
  const result = extractToolResultText(toolFormerData.result);

  return {
    type: "tool_use",
    id:
      (typeof toolFormerData.toolCallId === "string" && toolFormerData.toolCallId) ||
      `cursor-bubble-${bubbleId}`,
    name: mapCursorToolName(name),
    input: mapToolArgs(name, paramsRaw, result),
    _result: result,
    ...(hasToolError(toolFormerData.result) ? { _isError: true } : {}),
  } as any;
}

interface GlobalStateTurnEntry {
  turn: ParsedTurn;
  bubble: Record<string, any>;
}

interface GlobalStateBubbleEntry {
  bubble: Record<string, any>;
  turnTimestamp?: string;
}

function branchNameFromCursorValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, any>;
  return (
    branchNameFromCursorValue(obj.branchName) ||
    branchNameFromCursorValue(obj.name) ||
    branchNameFromCursorValue(obj.branch) ||
    branchNameFromCursorValue(obj.ref)
  );
}

function addUniqueBranch(branches: string[], seen: Set<string>, value: unknown): void {
  const branch = branchNameFromCursorValue(value);
  if (!branch || seen.has(branch)) return;
  seen.add(branch);
  branches.push(branch);
}

function sortCursorBranches(branches: unknown[]): unknown[] {
  if (
    branches.every(
      (branch) =>
        branch &&
        typeof branch === "object" &&
        Number.isFinite((branch as Record<string, any>).lastInteractionAt),
    )
  ) {
    return [...branches].sort(
      (a, b) =>
        Number((a as Record<string, any>).lastInteractionAt) -
        Number((b as Record<string, any>).lastInteractionAt),
    );
  }
  return branches;
}

function extractCursorBranchMetadata(composer: Record<string, any>): {
  gitBranch?: string;
  gitBranches?: string[];
} {
  const orderedBranches: string[] = [];
  const seen = new Set<string>();

  // Keep a stable timeline-ish order: created -> known branches -> committed/PR -> active.
  addUniqueBranch(orderedBranches, seen, composer.createdOnBranch);
  if (Array.isArray(composer.branches)) {
    for (const branch of sortCursorBranches(composer.branches)) {
      addUniqueBranch(orderedBranches, seen, branch);
    }
  }
  addUniqueBranch(orderedBranches, seen, composer.committedToBranch);
  addUniqueBranch(orderedBranches, seen, composer.prBranchName);
  addUniqueBranch(orderedBranches, seen, composer.activeBranch);

  const gitBranch =
    branchNameFromCursorValue(composer.activeBranch) ||
    branchNameFromCursorValue(composer.committedToBranch) ||
    orderedBranches[orderedBranches.length - 1];

  return {
    ...(gitBranch ? { gitBranch } : {}),
    ...(orderedBranches.length > 1 ? { gitBranches: orderedBranches } : {}),
  };
}

function extractRepositoryFromPrUrl(url: string): string {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
  return match ? match[1] : "";
}

function extractCursorPrLinks(entries: GlobalStateBubbleEntry[]): PrLink[] {
  const links: PrLink[] = [];
  const seenUrls = new Set<string>();

  for (const entry of entries) {
    const pullRequests = entry.bubble.pullRequests;
    if (!Array.isArray(pullRequests)) continue;

    for (const pr of pullRequests) {
      if (!pr || typeof pr !== "object") continue;
      const prObj = pr as Record<string, any>;
      const prUrl =
        typeof prObj.prUrl === "string"
          ? prObj.prUrl
          : typeof prObj.url === "string"
            ? prObj.url
            : typeof prObj.htmlUrl === "string"
              ? prObj.htmlUrl
              : typeof prObj.html_url === "string"
                ? prObj.html_url
                : "";
      if (!prUrl || seenUrls.has(prUrl)) continue;

      let prNumber = toNonNegativeInt(prObj.prNumber ?? prObj.number);
      if (prNumber <= 0) {
        const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
        if (match) prNumber = Number.parseInt(match[1], 10);
      }
      if (!Number.isFinite(prNumber) || prNumber <= 0) continue;

      const prRepository =
        (typeof prObj.prRepository === "string" && prObj.prRepository) ||
        (typeof prObj.repository === "string" && prObj.repository) ||
        (typeof prObj.repoFullName === "string" && prObj.repoFullName) ||
        extractRepositoryFromPrUrl(prUrl);

      seenUrls.add(prUrl);
      links.push({
        prNumber,
        prUrl,
        prRepository,
      });
    }
  }

  return links;
}

function extractCursorApiErrors(
  entries: GlobalStateBubbleEntry[],
): ProviderParseResult["apiErrors"] | undefined {
  const apiErrors: NonNullable<ProviderParseResult["apiErrors"]> = [];
  const seenKeys = new Set<string>();

  for (const entry of entries) {
    const rawDetails = entry.bubble.errorDetails;
    if (!rawDetails) continue;

    const details =
      typeof rawDetails === "string"
        ? (parseJson<Record<string, any>>(rawDetails) ?? { message: rawDetails })
        : typeof rawDetails === "object"
          ? (rawDetails as Record<string, any>)
          : null;
    if (!details) continue;

    const nestedError =
      typeof details.error === "string"
        ? parseJson<Record<string, any>>(details.error)
        : typeof details.error === "object"
          ? (details.error as Record<string, any>)
          : undefined;

    const statusCode =
      toNonNegativeInt(details.statusCode) ||
      toNonNegativeInt(details.status) ||
      toNonNegativeInt(nestedError?.statusCode) ||
      toNonNegativeInt(nestedError?.status) ||
      undefined;

    const errorType =
      (typeof nestedError?.error === "string" && nestedError.error) ||
      (typeof nestedError?.type === "string" && nestedError.type) ||
      (typeof details.type === "string" && details.type) ||
      undefined;

    const retryAttempt =
      toNonNegativeInt(details.retryAttempt) ||
      toNonNegativeInt(entry.bubble.retryAttempt) ||
      undefined;

    const timestamp =
      toIsoTimestamp(entry.bubble.createdAt) ||
      toIsoTimestamp(entry.bubble.lastUpdatedAt) ||
      entry.turnTimestamp ||
      new Date().toISOString();

    const dedupeKey = `${details.generationUUID || ""}::${timestamp}::${statusCode || ""}::${errorType || ""}::${details.message || ""}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    apiErrors.push({
      timestamp,
      ...(statusCode ? { statusCode } : {}),
      ...(errorType ? { errorType } : {}),
      ...(retryAttempt ? { retryAttempt } : {}),
    });
  }

  return apiErrors.length > 0 ? apiErrors : undefined;
}

function normalizeCursorContextFile(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n")) return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^file:\/\/(?:localhost)?/i, "");
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch {
      return undefined;
    }
    trimmed = trimmed.replace(/^\/([a-z]:\/)/i, "$1");
  }
  return trimmed;
}

function extractCursorContextFileFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, any>;
  const direct =
    normalizeCursorContextFile(obj.filePath) ||
    normalizeCursorContextFile(obj.path) ||
    normalizeCursorContextFile(obj.fsPath) ||
    normalizeCursorContextFile(obj.uri) ||
    normalizeCursorContextFile(obj.relativeWorkspacePath) ||
    normalizeCursorContextFile(obj.relativePath);
  if (direct) return direct;

  const name = normalizeCursorContextFile(obj.name);
  if (name && (name.includes("/") || name.includes(".") || name.startsWith("~"))) {
    return name;
  }
  return undefined;
}

function addUniqueContextFile(files: string[], seen: Set<string>, value: unknown): void {
  const file =
    normalizeCursorContextFile(value) || extractCursorContextFileFromObject(value) || undefined;
  if (!file || seen.has(file)) return;
  seen.add(file);
  files.push(file);
}

function addContextFilesFromAttachedFolderResult(
  files: string[],
  seen: Set<string>,
  value: unknown,
): void {
  const parsed =
    typeof value === "string"
      ? parseJson<Record<string, any>>(value)
      : value && typeof value === "object"
        ? (value as Record<string, any>)
        : undefined;
  if (!parsed) return;

  const directory =
    normalizeCursorContextFile(parsed.directoryRelativeWorkspacePath) ||
    normalizeCursorContextFile(parsed.directoryPath);

  if (Array.isArray(parsed.files)) {
    for (const file of parsed.files) {
      const name =
        file && typeof file === "object"
          ? normalizeCursorContextFile((file as Record<string, any>).name)
          : normalizeCursorContextFile(file);
      if (directory && name) {
        addUniqueContextFile(files, seen, join(directory, name));
        continue;
      }

      const direct =
        file && typeof file === "object"
          ? normalizeCursorContextFile((file as Record<string, any>).filePath) ||
            normalizeCursorContextFile((file as Record<string, any>).path) ||
            normalizeCursorContextFile((file as Record<string, any>).fsPath) ||
            normalizeCursorContextFile((file as Record<string, any>).uri) ||
            normalizeCursorContextFile((file as Record<string, any>).relativeWorkspacePath) ||
            normalizeCursorContextFile((file as Record<string, any>).relativePath)
          : undefined;
      if (direct) {
        addUniqueContextFile(files, seen, direct);
      } else if (name) {
        addUniqueContextFile(files, seen, name);
      }
    }
  }
}

function extractCursorContextSummary(
  entries: GlobalStateBubbleEntry[],
  requestContexts: Record<string, any>[],
): {
  contextFiles?: string[];
  requestContextCount?: number;
  hasRequestContextSidecars: boolean;
  hasCursorRules: boolean;
} {
  const files: string[] = [];
  const seen = new Set<string>();
  let hasRequestContextSidecars = false;
  let hasCursorRules = false;
  let requestContextCount = 0;

  for (const entry of entries) {
    for (const key of ["relevantFiles", "recentlyViewedFiles"] as const) {
      if (!Array.isArray(entry.bubble[key])) continue;
      for (const item of entry.bubble[key]) {
        addUniqueContextFile(files, seen, item);
      }
    }
  }

  for (const context of requestContexts) {
    const hasNonEmptyPayload = [
      context.terminalFiles,
      context.cursorRules,
      context.attachedFoldersListDirResults,
      context.summarizedComposers,
    ].some((value) => Array.isArray(value) && value.length > 0);
    if (!hasNonEmptyPayload) continue;

    hasRequestContextSidecars = true;
    requestContextCount++;
    if (Array.isArray(context.cursorRules) && context.cursorRules.length > 0) {
      hasCursorRules = true;
    }

    if (Array.isArray(context.terminalFiles)) {
      for (const item of context.terminalFiles) {
        addUniqueContextFile(files, seen, item);
      }
    }
    if (Array.isArray(context.attachedFoldersListDirResults)) {
      for (const item of context.attachedFoldersListDirResults) {
        addContextFilesFromAttachedFolderResult(files, seen, item);
      }
    }
  }

  return {
    ...(files.length > 0 ? { contextFiles: files.slice(0, 200) } : {}),
    ...(requestContextCount > 0 ? { requestContextCount } : {}),
    hasRequestContextSidecars,
    hasCursorRules,
  };
}

function loadCursorRequestContexts(db: any, sessionId: string): Record<string, any>[] {
  const rows = db.exec(
    `SELECT value FROM cursorDiskKV WHERE key LIKE ? LIMIT ${MAX_CURSOR_REQUEST_CONTEXT_ROWS}`,
    [`messageRequestContext:${sessionId}:%`],
  );
  if (!rows.length) return [];

  const contexts: Record<string, any>[] = [];
  for (const row of rows[0].values) {
    const raw = valueToString(row[0]);
    const parsed = parseJson<Record<string, any>>(raw);
    if (parsed) contexts.push(parsed);
  }
  return contexts;
}

function countCursorCheckpointEntries(db: any, sessionId: string): number {
  const rows = db.exec("SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE ?", [
    `checkpointId:${sessionId}:%`,
  ]);
  if (!rows.length || !rows[0].values.length) return 0;
  return toNonNegativeInt(rows[0].values[0][0]);
}

function mergeUniqueStrings(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const item of group) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      merged.push(item);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeCursorParseResults(
  primary: ProviderParseResult,
  enrichment: ProviderParseResult,
): ProviderParseResult {
  const mergedModel = chooseMergedCursorModel(primary.model, enrichment.model);
  const mergedTurnStats = mergeTurnStats(primary.turnStats, enrichment.turnStats);
  const mergedTokenUsage = primary.tokenUsage || enrichment.tokenUsage;
  const mergedTokenUsageByModel = primary.tokenUsageByModel || enrichment.tokenUsageByModel;
  const mergedTotalDurationMs =
    primary.totalDurationMs ||
    enrichment.totalDurationMs ||
    (mergedTurnStats && mergedTurnStats.length > 0
      ? mergedTurnStats.reduce((sum, stat) => sum + (stat.durationMs || 0), 0) || undefined
      : undefined);
  const mergedDuration = mergedTotalDurationMs !== undefined && !primary.totalDurationMs;
  const mergedTokens =
    (!primary.tokenUsage && !!enrichment.tokenUsage) ||
    (!primary.tokenUsageByModel && !!enrichment.tokenUsageByModel);
  const supplements = mergeUniqueStrings(
    primary.dataSourceInfo?.supplements,
    enrichment.dataSourceInfo?.sources,
  );
  const hasMeaningfulEnrichment =
    (!!mergedModel && mergedModel !== primary.model) ||
    mergedDuration ||
    mergedTokens ||
    (!!enrichment.gitBranch && !primary.gitBranch) ||
    (!!enrichment.gitBranches?.length && !primary.gitBranches?.length) ||
    (!!enrichment.prLinks?.length && !primary.prLinks?.length) ||
    (!!enrichment.apiErrors?.length && !primary.apiErrors?.length) ||
    (!!enrichment.contextFiles?.length && !primary.contextFiles?.length) ||
    (!!enrichment.cursorSidecars && !primary.cursorSidecars) ||
    (!!mergedTurnStats &&
      JSON.stringify(mergedTurnStats) !== JSON.stringify(primary.turnStats || undefined));
  const primaryNotes = (primary.dataSourceInfo?.notes || []).filter(
    (note) =>
      !(mergedTokens && /token usage is unavailable/i.test(note)) &&
      !(mergedDuration && /per-turn duration metrics are unavailable/i.test(note)),
  );
  const notes = mergeUniqueStrings(
    primaryNotes,
    hasMeaningfulEnrichment
      ? ["Session metadata was enriched from Cursor global-state payloads."]
      : undefined,
    hasMeaningfulEnrichment ? enrichment.dataSourceInfo?.notes : undefined,
  );
  const cursorSidecars = mergeCursorSidecars(primary.cursorSidecars, enrichment.cursorSidecars);

  return {
    ...primary,
    cwd: primary.cwd || enrichment.cwd,
    ...(mergedModel ? { model: mergedModel } : {}),
    ...(mergedTotalDurationMs !== undefined ? { totalDurationMs: mergedTotalDurationMs } : {}),
    ...(mergedTokenUsage ? { tokenUsage: mergedTokenUsage } : {}),
    ...(mergedTokenUsageByModel ? { tokenUsageByModel: mergedTokenUsageByModel } : {}),
    ...(mergedTurnStats ? { turnStats: mergedTurnStats } : {}),
    ...(primary.gitBranch ? {} : enrichment.gitBranch ? { gitBranch: enrichment.gitBranch } : {}),
    ...(primary.gitBranches
      ? {}
      : enrichment.gitBranches
        ? { gitBranches: enrichment.gitBranches }
        : {}),
    ...(primary.prLinks ? {} : enrichment.prLinks ? { prLinks: enrichment.prLinks } : {}),
    ...(primary.apiErrors ? {} : enrichment.apiErrors ? { apiErrors: enrichment.apiErrors } : {}),
    // store.db is currently the primary replay source and does not emit inferred context files.
    // If that changes, revisit this precedence rule instead of silently dropping enrichment files.
    ...(primary.contextFiles
      ? {}
      : enrichment.contextFiles
        ? { contextFiles: enrichment.contextFiles }
        : {}),
    ...(cursorSidecars ? { cursorSidecars } : {}),
    dataSourceInfo: primary.dataSourceInfo
      ? {
          ...primary.dataSourceInfo,
          ...(supplements ? { supplements } : {}),
          ...(notes ? { notes } : {}),
        }
      : enrichment.dataSourceInfo,
  };
}

function mergeCursorSidecars(
  primary: CursorSidecars | undefined,
  enrichment: CursorSidecars | undefined,
): CursorSidecars | undefined {
  if (!primary && !enrichment) return undefined;

  const merged: CursorSidecars = {
    ...((primary?.requestContextCount ?? enrichment?.requestContextCount)
      ? { requestContextCount: primary?.requestContextCount ?? enrichment?.requestContextCount }
      : {}),
    ...((primary?.checkpointCount ?? enrichment?.checkpointCount)
      ? { checkpointCount: primary?.checkpointCount ?? enrichment?.checkpointCount }
      : {}),
    ...((primary?.hasWorkspaceRules ?? enrichment?.hasWorkspaceRules) !== undefined
      ? { hasWorkspaceRules: primary?.hasWorkspaceRules ?? enrichment?.hasWorkspaceRules }
      : {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeCursorModelName(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const unique = [
    ...new Set(
      model
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0) return undefined;
  // Cursor can concatenate model labels as the session switches models.
  // We keep the last distinct label because it best represents the final model
  // shown to the user and matches how global-state payloads append updates.
  return unique[unique.length - 1];
}

function chooseMergedCursorModel(
  primary: string | undefined,
  enrichment: string | undefined,
): string | undefined {
  const normalizedPrimary = normalizeCursorModelName(primary);
  const normalizedEnrichment = normalizeCursorModelName(enrichment);
  return normalizedPrimary || normalizedEnrichment;
}

function mergeTurnStats(
  primary: TurnStat[] | undefined,
  enrichment: TurnStat[] | undefined,
): TurnStat[] | undefined {
  if (!primary?.length) return enrichment;
  if (!enrichment?.length) return primary;

  const maxTurnIndex = Math.max(
    ...primary.map((stat) => stat.turnIndex),
    ...enrichment.map((stat) => stat.turnIndex),
  );
  const primaryByIndex = new Map(primary.map((stat) => [stat.turnIndex, stat]));
  const enrichmentByIndex = new Map(enrichment.map((stat) => [stat.turnIndex, stat]));
  const merged: TurnStat[] = [];

  for (let turnIndex = 0; turnIndex <= maxTurnIndex; turnIndex++) {
    const current = primaryByIndex.get(turnIndex);
    const extra = enrichmentByIndex.get(turnIndex);
    if (!current && extra) {
      merged.push(extra);
      continue;
    }
    if (!current) continue;
    if (!extra) {
      merged.push(current);
      continue;
    }

    merged.push({
      ...current,
      ...(current.model ? {} : extra.model ? { model: extra.model } : {}),
      ...(current.durationMs !== undefined
        ? {}
        : extra.durationMs !== undefined
          ? { durationMs: extra.durationMs }
          : {}),
      ...(current.tokenUsage ? {} : extra.tokenUsage ? { tokenUsage: extra.tokenUsage } : {}),
      ...(current.contextTokens !== undefined
        ? {}
        : extra.contextTokens !== undefined
          ? { contextTokens: extra.contextTokens }
          : {}),
    });
  }

  return merged;
}

function extractBubbleModelName(
  bubble: Record<string, any>,
  fallbackModel: string | undefined,
): string | undefined {
  const fromModelInfo =
    bubble.modelInfo &&
    typeof bubble.modelInfo === "object" &&
    typeof bubble.modelInfo.modelName === "string"
      ? bubble.modelInfo.modelName
      : undefined;
  const fromBubble = typeof bubble.modelName === "string" ? bubble.modelName : undefined;
  const fromConfig =
    bubble.modelConfig &&
    typeof bubble.modelConfig === "object" &&
    typeof bubble.modelConfig.modelName === "string"
      ? bubble.modelConfig.modelName
      : undefined;
  return normalizeCursorModelName(fromModelInfo || fromBubble || fromConfig || fallbackModel);
}

function extractBubbleDurationMs(bubble: Record<string, any>): number | undefined {
  const thinkingMs = toPositiveMs(bubble.thinkingDurationMs);
  const toolMs = extractToolExecutionTimeMs((bubble.toolFormerData as any)?.result);
  if (thinkingMs !== undefined && toolMs !== undefined) return thinkingMs + toolMs;
  return thinkingMs ?? toolMs;
}

function buildGlobalStateMetrics(
  entries: GlobalStateTurnEntry[],
  fallbackModel: string | undefined,
  sessionTokenUsage?: TokenUsage,
): {
  tokenUsage?: TokenUsage;
  tokenUsageByModel?: Record<string, TokenUsage>;
  turnStats?: TurnStat[];
  totalDurationMs?: number;
} {
  if (entries.length === 0) return {};

  const totals = emptyTokenUsage();
  const byModel: Record<string, TokenUsage> = {};
  const turnStats: TurnStat[] = [];
  const lastSnapshotByModel = new Map<string, TokenUsage>();
  let currentTurnIndex = -1;

  for (const entry of entries) {
    if (entry.turn.role === "user") {
      currentTurnIndex++;
      turnStats.push({ turnIndex: currentTurnIndex });
      continue;
    }

    if (currentTurnIndex < 0) continue;
    const current = turnStats[currentTurnIndex];

    const bubbleModel = extractBubbleModelName(entry.bubble, fallbackModel);
    if (!current.model && bubbleModel) {
      current.model = bubbleModel;
    }

    const bubbleUsage = tokenUsageFromCursorTokenCount(entry.bubble.tokenCount);
    if (bubbleUsage) {
      const usageModel = bubbleModel || "unknown";
      const previousSnapshot = lastSnapshotByModel.get(usageModel);
      const { increment, nextSnapshot } = estimateTokenIncrement(bubbleUsage, previousSnapshot);
      lastSnapshotByModel.set(usageModel, nextSnapshot);

      if (hasAnyTokens(increment)) {
        if (!current.tokenUsage) current.tokenUsage = emptyTokenUsage();
        addTokenUsage(current.tokenUsage, increment);
        addTokenUsage(totals, increment);

        if (!byModel[usageModel]) byModel[usageModel] = emptyTokenUsage();
        addTokenUsage(byModel[usageModel], increment);
      }

      current.contextTokens = Math.max(
        current.contextTokens || 0,
        bubbleUsage.inputTokens + bubbleUsage.cacheReadTokens + bubbleUsage.cacheCreationTokens,
      );
    }

    const bubbleDurationMs = extractBubbleDurationMs(entry.bubble);
    if (bubbleDurationMs !== undefined) {
      current.durationMs = (current.durationMs || 0) + bubbleDurationMs;
    }
  }

  for (const stat of turnStats) {
    if (stat.tokenUsage && !hasAnyTokens(stat.tokenUsage)) {
      delete stat.tokenUsage;
    }
    if ((stat.durationMs || 0) <= 0) {
      delete stat.durationMs;
    }
    if ((stat.contextTokens || 0) <= 0) {
      delete stat.contextTokens;
    }
  }

  const totalDurationMs =
    turnStats.length > 0
      ? turnStats.reduce((sum, stat) => sum + (stat.durationMs || 0), 0) || undefined
      : undefined;

  const totalTokens =
    sessionTokenUsage && hasAnyTokens(sessionTokenUsage) ? sessionTokenUsage : totals;

  return {
    ...(hasAnyTokens(totalTokens) ? { tokenUsage: totalTokens } : {}),
    ...(Object.keys(byModel).length > 0 ? { tokenUsageByModel: byModel } : {}),
    ...(turnStats.length > 0 ? { turnStats } : {}),
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
  };
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

    const text = normalizeAssistantTurnText(bubble.text, !!bubble.toolFormerData);
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

async function parseCursorGlobalStateDb(
  sessionId: string,
  globalStateDb?: CachedSqlJsDb,
): Promise<ProviderParseResult | null> {
  const resolvedGlobalStateDb = globalStateDb ?? (await openGlobalStateDb());
  if (!resolvedGlobalStateDb) return null;
  const { db } = resolvedGlobalStateDb;

  try {
    const composerRows = db.exec("SELECT value FROM cursorDiskKV WHERE key = ?", [
      `composerData:${sessionId}`,
    ]);
    if (!composerRows.length || !composerRows[0].values.length) return null;

    const rawComposer = valueToString(composerRows[0].values[0][0]);
    const composer = parseJson<Record<string, any>>(rawComposer);
    if (!composer) return null;

    if (countComposerConversationHeaders(composer) === 0) return null;
    const headers = composer.fullConversationHeadersOnly as any[];

    const entries: GlobalStateTurnEntry[] = [];
    const bubbleEntries: GlobalStateBubbleEntry[] = [];
    const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    for (const header of headers) {
      const bubbleId =
        header && typeof header === "object" && typeof (header as any).bubbleId === "string"
          ? (header as any).bubbleId
          : "";
      if (!bubbleId) continue;

      try {
        bubbleStmt.bind([`bubbleId:${sessionId}:${bubbleId}`]);
        if (bubbleStmt.step()) {
          const rawBubble = valueToString(bubbleStmt.get()[0]);
          const bubble = parseJson<Record<string, any>>(rawBubble);
          if (bubble) {
            bubbleEntries.push({
              bubble,
              turnTimestamp:
                toIsoTimestamp(bubble.createdAt) ||
                toIsoTimestamp(bubble.lastUpdatedAt) ||
                undefined,
            });
            const turn = bubbleToTurn(bubble);
            if (turn) entries.push({ turn, bubble });
          }
        }
      } finally {
        bubbleStmt.reset();
      }
    }
    bubbleStmt.free();

    const turns = entries.map((entry) => entry.turn);
    if (turns.length === 0) return null;

    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser?.blocks.find((b) => b.type === "text") as any;
    const inferredProject = await inferProjectFromComposerData(rawComposer, []);
    const modelName = normalizeCursorModelName(
      composer.modelConfig &&
        typeof composer.modelConfig === "object" &&
        typeof composer.modelConfig.modelName === "string"
        ? composer.modelConfig.modelName
        : undefined,
    );
    const requestContexts = loadCursorRequestContexts(db, sessionId);

    const startTime = toIsoTimestamp(composer.createdAt);
    const endTime = toIsoTimestamp(composer.lastUpdatedAt);
    const sessionTokenUsage = tokenUsageFromCursorTokenCount(composer.tokenCount);
    const metrics = buildGlobalStateMetrics(entries, modelName, sessionTokenUsage);
    const branchMeta = extractCursorBranchMetadata(composer);
    const prLinks = extractCursorPrLinks(bubbleEntries);
    const apiErrors = extractCursorApiErrors(bubbleEntries);
    const contextSummary = extractCursorContextSummary(bubbleEntries, requestContexts);
    const checkpointCount = countCursorCheckpointEntries(db, sessionId);

    const notes = ["cursorDiskKV keys: composerData:* + bubbleId:*"];
    if (!metrics.tokenUsage) {
      notes.push("Token usage is unavailable in this Cursor global-state session.");
    } else if (metrics.tokenUsageByModel?.unknown) {
      notes.push("Model attribution is partial; some token usage is grouped under 'unknown'.");
      notes.push("Token usage is estimated from Cursor token snapshots and may be approximate.");
    } else {
      notes.push("Token usage is estimated from Cursor token snapshots.");
    }
    if (metrics.totalDurationMs !== undefined) {
      notes.push("Duration is estimated from Cursor thinking and tool execution timing.");
    } else {
      notes.push("Duration is unavailable for this Cursor global-state session.");
    }
    const hasDetailedTurnStats = Boolean(
      metrics.turnStats?.some(
        (stat) => !!stat.durationMs || !!stat.contextTokens || !!stat.tokenUsage,
      ),
    );
    if (!hasDetailedTurnStats) {
      notes.push("Per-turn metrics are limited for this session.");
    }
    if (branchMeta.gitBranch) {
      notes.push("Git branch is inferred from Cursor composer metadata.");
    }
    if (contextSummary.contextFiles?.length) {
      notes.push(
        "Context files are inferred from Cursor relevantFiles and request-context sidecars.",
      );
    }
    const cursorSidecars =
      contextSummary.requestContextCount || checkpointCount > 0 || contextSummary.hasCursorRules
        ? {
            ...(contextSummary.requestContextCount
              ? { requestContextCount: contextSummary.requestContextCount }
              : {}),
            ...(checkpointCount > 0 ? { checkpointCount } : {}),
            ...(contextSummary.hasCursorRules ? { hasWorkspaceRules: true } : {}),
          }
        : undefined;

    return {
      sessionId,
      slug: sessionId.slice(0, 8),
      title:
        (typeof composer.name === "string" && composer.name.trim()) ||
        (firstText?.text as string | undefined)?.slice(0, 80),
      cwd: inferredProject || "",
      model: modelName,
      startTime,
      endTime,
      ...(metrics.totalDurationMs !== undefined
        ? { totalDurationMs: metrics.totalDurationMs }
        : {}),
      ...(metrics.tokenUsage ? { tokenUsage: metrics.tokenUsage } : {}),
      ...(metrics.tokenUsageByModel ? { tokenUsageByModel: metrics.tokenUsageByModel } : {}),
      ...(metrics.turnStats ? { turnStats: metrics.turnStats } : {}),
      ...(branchMeta.gitBranch ? { gitBranch: branchMeta.gitBranch } : {}),
      ...(branchMeta.gitBranches ? { gitBranches: branchMeta.gitBranches } : {}),
      ...(prLinks.length > 0 ? { prLinks } : {}),
      ...(apiErrors ? { apiErrors } : {}),
      ...(contextSummary.contextFiles ? { contextFiles: contextSummary.contextFiles } : {}),
      ...(cursorSidecars ? { cursorSidecars } : {}),
      turns,
      dataSource: "global-state",
      dataSourceInfo: {
        primary: "global-state",
        sources: ["cursor/user/globalStorage/state.vscdb"],
        notes,
      },
    };
  } catch {
    return null;
  }
}

interface CursorToolResult {
  result: string;
  isError?: boolean;
  executionTimeMs?: number;
}

function buildToolResultMap(messages: CursorMessage[]): Map<string, CursorToolResult> {
  const map = new Map<string, CursorToolResult>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool-result" && block.toolCallId) {
        const resultText = extractToolResultText(block.result);
        const topLevelResult = msg.providerOptions?.cursor?.highLevelToolCallResult;
        const combinedSource = topLevelResult || block.result;
        map.set(block.toolCallId, {
          result: resultText,
          ...(hasToolError(combinedSource) ? { isError: true } : {}),
          ...(extractToolExecutionTimeMs(combinedSource) !== undefined
            ? { executionTimeMs: extractToolExecutionTimeMs(combinedSource) }
            : {}),
        });
      }
    }
  }
  return map;
}

function messagesToTurns(messages: CursorMessage[]): {
  turns: ParsedTurn[];
  turnStats: TurnStat[];
  totalDurationMs?: number;
} {
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

  const turnStats = buildStoreTurnStats(turns);
  const totalDurationMs =
    turnStats.length > 0
      ? turnStats.reduce((sum, stat) => sum + (stat.durationMs || 0), 0) || undefined
      : undefined;
  return { turns, turnStats, totalDurationMs };
}

export const CURSOR_SYSTEM_CONTEXT_RE =
  /^<(?:user_info|system_reminder|agent_transcripts|rules|git_status)>/;

export function isSystemContextText(text: string): boolean {
  return CURSOR_SYSTEM_CONTEXT_RE.test(text.trim());
}

function parseUserContent(content: string | CursorBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    if (isSystemContextText(content)) return [];
    const cleaned = content.replace(/<\/?user_query>/g, "").trim();
    if (isSystemContextText(cleaned)) return [];
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text) {
      if (isSystemContextText(b.text)) continue;
      const cleaned = b.text.replace(/<\/?user_query>/g, "").trim();
      if (isSystemContextText(cleaned)) continue;
      if (cleaned) blocks.push({ type: "text", text: cleaned });
    }
  }
  return blocks;
}

function parseAssistantContent(
  content: string | CursorBlock[] | undefined,
  toolResults: Map<string, CursorToolResult>,
): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    const cleaned = sanitizeCursorAssistantText(content, false);
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }

  const blocks: ContentBlock[] = [];
  const hasToolCalls = content.some((block) => block.type === "tool-call");
  for (const b of content) {
    if (b.type === "reasoning" && b.text?.trim()) {
      const thinking = sanitizeCursorReasoningText(b.text);
      if (thinking) blocks.push({ type: "thinking", thinking } as ContentBlock);
    } else if (b.type === "text" && b.text?.trim()) {
      const text = sanitizeCursorAssistantText(b.text, hasToolCalls);
      if (text) blocks.push({ type: "text", text });
    } else if (b.type === "tool-call" && b.toolCallId && b.toolName) {
      const result = toolResults.get(b.toolCallId);
      const toolBlock: any = {
        type: "tool_use",
        id: b.toolCallId,
        name: mapCursorToolName(b.toolName),
        input: mapToolArgs(b.toolName, b.args || {}, result?.result || ""),
        _result: result?.result || "",
        ...(result?.isError ? { _isError: true } : {}),
        ...(result?.executionTimeMs ? { _durationMs: result.executionTimeMs } : {}),
      };
      blocks.push(toolBlock);
    }
  }
  return blocks;
}

function buildStoreTurnStats(turns: ParsedTurn[]): TurnStat[] {
  const turnStats: TurnStat[] = [];
  let currentTurnIndex = -1;

  for (const turn of turns) {
    if (turn.role === "user") {
      currentTurnIndex++;
      turnStats.push({ turnIndex: currentTurnIndex });
      continue;
    }

    if (currentTurnIndex < 0) continue;
    const current = turnStats[currentTurnIndex];
    if (!current.model && turn.model) current.model = turn.model;

    for (const block of turn.blocks as any[]) {
      if (block?.type !== "tool_use") continue;
      const ms = toPositiveMs(block._durationMs);
      if (ms !== undefined) {
        current.durationMs = (current.durationMs || 0) + ms;
      }
    }
  }

  return turnStats;
}

function mapCursorToolName(name: string): string {
  const mapping: Record<string, string> = {
    Shell: "Bash",
    run_terminal_command_v2: "Bash",
    run_terminal_cmd: "Bash",
    Read: "Read",
    ReadFile: "Read",
    read_file_v2: "Read",
    read_file: "Read",
    read_lints: "ReadLints",
    Grep: "Grep",
    ripgrep_raw_search: "Grep",
    ripgrep: "Grep",
    rg: "Grep",
    grep: "Grep",
    grep_search: "Grep",
    Glob: "Glob",
    glob_file_search: "Glob",
    file_search: "Glob",
    list_dir: "Glob",
    list_dir_v2: "Glob",
    LS: "Glob",
    StrReplace: "Edit",
    EditFile: "Edit",
    edit_file_v2: "Edit",
    edit_file: "Edit",
    search_replace: "Edit",
    ApplyPatch: "Edit",
    apply_patch: "Edit",
    Write: "Write",
    WriteFile: "Write",
    write: "Write",
    Delete: "Delete",
    delete_file: "Delete",
    Task: "Agent",
    task_v2: "Agent",
    todo_write: "TodoWrite",
    ask_question: "AskQuestion",
    semantic_search_full: "SemanticSearch",
    codebase_search: "SemanticSearch",
    web_search: "WebSearch",
    WebFetch: "WebFetch",
    web_fetch: "WebFetch",
    create_plan: "Plan",
  };
  if (mapping[name]) return mapping[name];
  if (name.startsWith("mcp-cursor-ide-browser-cursor-ide-browser-browser_")) return "Browser";
  if (name.startsWith("chrome-devtools-")) return "Browser";
  return name;
}

function parseDiffStringSnippet(diffString: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diffString.split("\n")) {
    if (
      line.startsWith("@@") ||
      line.startsWith("*** ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }
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
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function inferEditStringsFromResult(resultText: string): {
  old_string?: string;
  new_string?: string;
} {
  if (!resultText.trim()) return {};
  const parsed = parseJson<Record<string, any>>(resultText);
  if (!parsed || typeof parsed !== "object") return {};

  const out: { old_string?: string; new_string?: string } = {};
  if (typeof parsed.contentsAfterEdit === "string" && parsed.contentsAfterEdit.trim()) {
    out.new_string = parsed.contentsAfterEdit;
  }

  const chunks =
    parsed.diff &&
    typeof parsed.diff === "object" &&
    Array.isArray((parsed.diff as Record<string, any>).chunks)
      ? ((parsed.diff as Record<string, any>).chunks as any[])
      : [];
  const oldParts: string[] = [];
  const newParts: string[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.diffString !== "string" || !chunk.diffString.trim()) continue;
    const parsedSnippet = parseDiffStringSnippet(chunk.diffString);
    if (parsedSnippet.oldText) oldParts.push(parsedSnippet.oldText);
    if (parsedSnippet.newText) newParts.push(parsedSnippet.newText);
  }
  if (oldParts.length > 0) out.old_string = oldParts.join("\n");
  if (!out.new_string && newParts.length > 0) out.new_string = newParts.join("\n");
  return out;
}

function parseApplyPatchArgs(rawPatch: string): Record<string, any> {
  const fileMatch = rawPatch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/m);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of rawPatch.split("\n")) {
    if (
      line.startsWith("*** ") ||
      line.startsWith("@@") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }
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
  return {
    ...(fileMatch?.[1] ? { file_path: fileMatch[1].trim() } : {}),
    old_string: oldLines.join("\n"),
    new_string: newLines.join("\n"),
    patch: rawPatch,
  };
}

function mapEditLikeArgs(argsObj: Record<string, any>, resultText: string): Record<string, any> {
  const mapped: Record<string, any> = {
    file_path: argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? "",
    old_string: argsObj.old_string ?? argsObj.oldStr ?? "",
    new_string:
      argsObj.new_string ?? argsObj.newStr ?? argsObj.streamingContent ?? argsObj.content ?? "",
  };
  if (!mapped.old_string || !mapped.new_string) {
    const inferred = inferEditStringsFromResult(resultText);
    if (!mapped.old_string && inferred.old_string) mapped.old_string = inferred.old_string;
    if (!mapped.new_string && inferred.new_string) mapped.new_string = inferred.new_string;
  }
  return mapped;
}

function mapToolArgs(toolName: string, args: unknown, resultText = ""): Record<string, any> {
  const argsObj =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, any>) : null;
  if (toolName === "ApplyPatch" || toolName === "apply_patch") {
    const rawPatch =
      typeof args === "string"
        ? args
        : typeof argsObj?.patch === "string"
          ? argsObj.patch
          : typeof argsObj?.input === "string"
            ? argsObj.input
            : typeof argsObj?.content === "string"
              ? argsObj.content
              : typeof argsObj?.contents === "string"
                ? argsObj.contents
                : "";
    if (rawPatch) return parseApplyPatchArgs(rawPatch);
    if (argsObj && (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)) {
      return mapEditLikeArgs(argsObj, resultText);
    }
    return argsObj || {};
  }
  if (typeof args === "string") {
    return { raw: args };
  }
  if (!argsObj) return {};
  if (toolName === "Shell" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.description ? { description: argsObj.description } : {}),
    };
  }
  if (
    toolName === "StrReplace" &&
    (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)
  ) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    toolName === "EditFile" &&
    (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)
  ) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (toolName === "Edit" && (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    (toolName === "Write" || toolName === "WriteFile") &&
    (argsObj.path || argsObj.relativeWorkspacePath || argsObj.targetFile || argsObj.file_path)
  ) {
    const codeValue =
      typeof argsObj.code === "string"
        ? argsObj.code
        : argsObj.code && typeof argsObj.code === "object" && typeof argsObj.code.code === "string"
          ? argsObj.code.code
          : "";
    return {
      file_path:
        argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? argsObj.targetFile,
      content: argsObj.contents ?? argsObj.content ?? codeValue,
    };
  }
  if ((toolName === "Read" || toolName === "ReadFile") && argsObj.path) {
    return { file_path: argsObj.path };
  }
  if (toolName === "run_terminal_command_v2" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.commandDescription ? { description: argsObj.commandDescription } : {}),
      ...(argsObj.cwd ? { cwd: argsObj.cwd } : {}),
    };
  }
  if (toolName === "run_terminal_cmd" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.cwd ? { cwd: argsObj.cwd } : {}),
      ...(argsObj.requireUserApproval !== undefined
        ? { requireUserApproval: Boolean(argsObj.requireUserApproval) }
        : {}),
    };
  }
  if (toolName === "read_file_v2" && argsObj.targetFile) {
    return { file_path: argsObj.targetFile };
  }
  if (toolName === "read_file" && argsObj.targetFile) {
    return { file_path: argsObj.targetFile };
  }
  if (toolName === "edit_file_v2" && argsObj.relativeWorkspacePath) {
    return {
      file_path: argsObj.relativeWorkspacePath,
      new_string: argsObj.streamingContent ?? "",
    };
  }
  if (toolName === "edit_file" || toolName === "search_replace") {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    toolName === "write" &&
    (argsObj.relativeWorkspacePath || argsObj.path || argsObj.targetFile)
  ) {
    const codeValue =
      typeof argsObj.code === "string"
        ? argsObj.code
        : argsObj.code && typeof argsObj.code === "object" && typeof argsObj.code.code === "string"
          ? argsObj.code.code
          : "";
    return {
      file_path: argsObj.relativeWorkspacePath ?? argsObj.path ?? argsObj.targetFile,
      content: argsObj.content ?? argsObj.contents ?? codeValue,
    };
  }
  if (
    (toolName === "Delete" || toolName === "delete_file") &&
    (argsObj.relativeWorkspacePath || argsObj.path || argsObj.file_path || argsObj.targetFile)
  ) {
    return {
      file_path:
        argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? argsObj.targetFile,
    };
  }
  if (toolName === "list_dir" || toolName === "list_dir_v2" || toolName === "LS") {
    return {
      path: argsObj.targetDirectory ?? argsObj.target_directory ?? "",
    };
  }
  if (toolName === "glob_file_search") {
    return {
      pattern: argsObj.globPattern ?? "",
      path: argsObj.targetDirectory ?? "",
    };
  }
  if (toolName === "file_search") {
    return {
      pattern: argsObj.pattern ?? argsObj.query ?? argsObj.searchTerm ?? "",
      path: argsObj.path ?? argsObj.targetDirectory ?? "",
    };
  }
  if (toolName === "ripgrep_raw_search") {
    return {
      pattern: argsObj.pattern ?? "",
      path: argsObj.path ?? "",
      ...(argsObj.glob ? { glob: argsObj.glob } : {}),
      ...(argsObj.caseInsensitive !== undefined
        ? { case_insensitive: Boolean(argsObj.caseInsensitive) }
        : {}),
    };
  }
  if (toolName === "ripgrep") {
    return {
      pattern: argsObj.pattern ?? argsObj.query ?? "",
      path: argsObj.path ?? argsObj.targetDirectory ?? "",
      ...(argsObj.glob ? { glob: argsObj.glob } : {}),
    };
  }
  if (toolName === "web_search" && argsObj.searchTerm) {
    return { search_term: argsObj.searchTerm };
  }
  if (toolName === "codebase_search") {
    return {
      query: argsObj.query ?? "",
      path:
        argsObj.repositoryInfo &&
        typeof argsObj.repositoryInfo === "object" &&
        typeof (argsObj.repositoryInfo as Record<string, any>).relativeWorkspacePath === "string"
          ? (argsObj.repositoryInfo as Record<string, any>).relativeWorkspacePath
          : "",
      ...(argsObj.includePattern ? { includePattern: argsObj.includePattern } : {}),
    };
  }
  if (toolName === "task_v2" || toolName === "Task") {
    return {
      ...(argsObj.description ? { description: argsObj.description } : {}),
      ...(argsObj.prompt ? { prompt: argsObj.prompt } : {}),
      ...(argsObj.subagentType ? { subagent_type: argsObj.subagentType } : {}),
    };
  }
  if (toolName.startsWith("mcp-") && Array.isArray(argsObj.tools) && argsObj.tools.length > 0) {
    const first = argsObj.tools[0] || {};
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
  return argsObj;
}

function extractModel(msg: CursorMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;
  for (const b of msg.content) {
    const model = b.providerOptions?.cursor?.modelName;
    if (model) return normalizeCursorModelName(model);
  }
  return undefined;
}

export const __testables = {
  buildGlobalStateMetrics,
  buildStoreTurnStats,
  createRetryableInit,
  estimateTokenIncrement,
  extractCursorApiErrors,
  extractCursorBranchMetadata,
  extractCursorContextSummary,
  extractCursorPrLinks,
  hasReplayableRootBlob,
  mapCursorToolName,
  mapToolArgs,
  mergeCursorParseResults,
  mergeTurnStats,
  parseAssistantContent,
  inferProjectFromComposerData,
  inferProjectRootFromPathHint,
  normalizeTurnText,
  normalizeCursorModelName,
  parseThinking,
  parseUserContent,
};
