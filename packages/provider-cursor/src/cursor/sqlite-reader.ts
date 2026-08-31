/// <reference path="../sql-js.d.ts" />
import type { Database, SqlJsStatic } from "sql.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { CursorSidecars, PrLink, TokenUsage, TurnStat } from "@vibe-replay/types";
import { readFileCache, writeFileCache } from "@vibe-replay/provider-core/cache";
import {
  buildTurnDurationIntervals,
  sumDurationIntervals,
} from "@vibe-replay/provider-core/duration";
import type {
  Compaction,
  ContentBlock,
  ParsedTurn,
  SessionInfo,
} from "@vibe-replay/provider-contract";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import type { ProviderParseResult } from "@vibe-replay/provider-contract";
import {
  sanitizeCursorAssistantText,
  sanitizeCursorReasoningText,
  sanitizeCursorUserText,
} from "./sanitize.js";
import { createRetryableInit, CURSOR_CHATS_DIR, workspaceHash } from "./sqlite-io.js";
// Local use requires named imports in addition to the compatibility re-exports below.
import { mapCursorToolName, mapToolArgs, parseJson } from "./tool-mapping.js";

export { storeDbPath, workspaceHash } from "./sqlite-io.js";
export { mapCursorToolName, mapToolArgs } from "./tool-mapping.js";

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;
const UNC_PATH_RE = /^\/\//;

const MIN_STORE_DB_SIZE = 8192;
const MAX_CURSOR_REQUEST_CONTEXT_ROWS = 500;
const SQLITE_CLI_MAX_BUFFER = 256 * 1024 * 1024;
const SQLITE_CLI_QUERY_TIMEOUT_MS = 120_000;
const MAX_CURSOR_GLOBAL_STATE_TOOL_RESULT_CHARS = 10_000;
const GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE = 200;
const CURSOR_AGENTKV_BLOB_PREFIX = "agentKv:blob:";
const execFileAsync = promisify(execFile);

const getSqlJs = createRetryableInit(async () => {
  const mod = await import("sql.js");
  return mod.default();
});

interface CachedSqlJsDb {
  dbPath: string;
  backend: "sqljs";
  db: Database;
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

interface CachedSqliteCliDb {
  dbPath: string;
  backend: "sqlite-cli";
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

type CachedGlobalStateDb = CachedSqlJsDb | CachedSqliteCliDb;

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
  walSize?: number;
  walMtimeMs?: number;
  decodedPathsHash: string;
  sessions: SessionInfo[];
  sessionIds: string[];
}

export interface CursorLiveDiagnostics {
  // Keep in sync with LiveCursorDiagnostics in packages/viewer/src/hooks/useSessionLoader.ts.
  source: "global-state";
  signature: string;
  probedAt: string;
  dbPath: string;
  dbMtimeMs: number;
  walMtimeMs: number;
  walSize: number;
  composerBytes: number;
  headerCount: number;
  composerLastUpdatedAt?: string;
  latestBubbleId?: string;
  latestBubbleCreatedAt?: string;
  latestBubbleUpdatedAt?: string;
  latestBubbleType?: number;
  latestTextPreview?: string;
  latestToolName?: string;
  latestToolHasResult?: boolean;
  latestToolResultLength?: number;
  bubbleCount: number;
  toolCallCount: number;
  toolResultCount: number;
  pendingToolCount: number;
  maxBubbleBytes: number;
  totalBubbleBytes: number;
}

let cachedGlobalStateDb: CachedGlobalStateDb | null = null;

// Releasing a sql.js Database can throw if the underlying memory was already
// freed (e.g. by a previous close() in a refresh path). Swallow defensively —
// we drop the cache slot either way.
function closeCachedSqlJsDb(): void {
  if (cachedGlobalStateDb?.backend !== "sqljs") return;
  try {
    cachedGlobalStateDb.db.close();
  } catch {
    // ignore — we're discarding the reference next anyway
  }
}

let cachedStoreDbIndex: Map<string, StoreDbIndexEntry> | null = null;
const resolvedProjectRootCache = new Map<string, Promise<string | null>>();
const GLOBAL_STATE_DISCOVERY_CACHE_PREFIX = "cursor-global-state-discovery-v7";

interface CursorComposerHeader {
  composerId: string;
  isSubagent: boolean;
  subagentInfo?: {
    parentComposerId?: string;
    toolCallId?: string;
  };
}

let cachedComposerHeaders:
  | {
      dbPath: string;
      size: number;
      mtimeMs: number;
      walSize: number;
      walMtimeMs: number;
      headers: Map<string, CursorComposerHeader>;
    }
  | undefined;

function globalStateDbCandidates(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const joinPath = platform === "win32" ? win32.join : posix.join;
  const candidates = [
    joinPath(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    joinPath(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];

  if (platform === "win32") {
    const appData = env.APPDATA || joinPath(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || joinPath(home, "AppData", "Local");
    candidates.push(joinPath(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
    candidates.push(joinPath(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"));
  } else {
    if (env.APPDATA) {
      candidates.push(joinPath(env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(joinPath(env.LOCALAPPDATA, "Cursor", "User", "globalStorage", "state.vscdb"));
    }
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

async function globalStateWalFingerprint(dbPath: string): Promise<{
  walSize: number;
  walMtimeMs: number;
}> {
  const walStat = await stat(`${dbPath}-wal`).catch(() => null);
  return {
    walSize: walStat?.isFile() ? walStat.size : 0,
    walMtimeMs: walStat?.isFile() ? walStat.mtimeMs : 0,
  };
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nextStringPrefix(prefix: string): string | null {
  if (!prefix) return null;
  const chars = [...prefix];
  const last = chars.pop();
  if (!last) return null;
  const codePoint = last.codePointAt(0);
  if (codePoint === undefined || codePoint >= 0x10ffff) return null;
  const next = codePoint + 1;
  if (next >= 0xd800 && next <= 0xdfff) return null;
  return `${chars.join("")}${String.fromCodePoint(next)}`;
}

function sqlKeyPrefixRange(prefix: string, column = "key"): string {
  const upperBound = nextStringPrefix(prefix);
  if (!upperBound) return `${column} >= ${sqlString(prefix)}`;
  return `${column} >= ${sqlString(prefix)} AND ${column} < ${sqlString(upperBound)}`;
}

function projectedCursorBubbleSelectSql(): string {
  const value = "value";
  const toolResult = `json_extract(${value}, '$.toolFormerData.result')`;
  const truncatedToolResult = [
    "CASE",
    `WHEN json_type(${value}, '$.toolFormerData.result') = 'text'`,
    `THEN substr(${toolResult}, 1, ${MAX_CURSOR_GLOBAL_STATE_TOOL_RESULT_CHARS})`,
    `ELSE ${toolResult}`,
    "END",
  ].join(" ");
  return [
    "key",
    `json_extract(${value}, '$.type') AS type`,
    `json_extract(${value}, '$.text') AS text`,
    `json_extract(${value}, '$.thinking') AS thinking`,
    `json_extract(${value}, '$.createdAt') AS createdAt`,
    `json_extract(${value}, '$.lastUpdatedAt') AS lastUpdatedAt`,
    `json_extract(${value}, '$.timingInfo') AS timingInfo`,
    `json_extract(${value}, '$.thinkingDurationMs') AS thinkingDurationMs`,
    `json_extract(${value}, '$.tokenCount') AS tokenCount`,
    `json_extract(${value}, '$.modelInfo') AS modelInfo`,
    `json_extract(${value}, '$.modelName') AS modelName`,
    `json_extract(${value}, '$.modelConfig') AS modelConfig`,
    `json_extract(${value}, '$.toolFormerData.name') AS toolName`,
    `json_extract(${value}, '$.toolFormerData.params') AS toolParams`,
    `${truncatedToolResult} AS toolResult`,
    `json_extract(${value}, '$.toolFormerData.result') IS NOT NULL AS toolHasResult`,
    `length(${toolResult}) AS toolResultLength`,
    `json_extract(${value}, '$.toolFormerData.toolCallId') AS toolCallId`,
    `json_extract(${value}, '$.pullRequests') AS pullRequests`,
    `json_extract(${value}, '$.errorDetails') AS errorDetails`,
    `json_extract(${value}, '$.retryAttempt') AS retryAttempt`,
    `json_extract(${value}, '$.relevantFiles') AS relevantFiles`,
    `json_extract(${value}, '$.recentlyViewedFiles') AS recentlyViewedFiles`,
  ].join(", ");
}

function replayableGlobalStateBubblePredicateSql(valueExpr: string): string {
  // Discovery only needs a cheap positive signal; bubbleToTurn remains the
  // authoritative parser and may still filter system-context-only text later.
  const nonEmptyText = (path: string) =>
    `(json_type(${valueExpr}, ${sqlString(path)}) = 'text' AND length(trim(COALESCE(json_extract(${valueExpr}, ${sqlString(
      path,
    )}), ''))) > 0)`;
  return [
    nonEmptyText("$.text"),
    nonEmptyText("$.thinking"),
    nonEmptyText("$.thinking.text"),
    nonEmptyText("$.toolFormerData.name"),
  ].join(" OR ");
}

function replayableGlobalStateBubbleCountSql(
  composerValueExpr: string,
  composerKeyExpr: string,
): string {
  const inlineBubblePredicate = replayableGlobalStateBubblePredicateSql("conversation.value");
  const referencedBubblePredicate = replayableGlobalStateBubblePredicateSql("bubble.value");
  return [
    "COALESCE((",
    "SELECT COUNT(*) FROM json_each(",
    composerValueExpr,
    ", '$.conversation') AS conversation",
    " WHERE json_type(conversation.value) = 'object' AND (",
    inlineBubblePredicate,
    ")",
    "), 0) + COALESCE((",
    "SELECT COUNT(*) FROM json_each(",
    composerValueExpr,
    ", '$.fullConversationHeadersOnly') AS header",
    " JOIN cursorDiskKV AS bubble ON bubble.key = 'bubbleId:' || substr(",
    composerKeyExpr,
    ", length('composerData:') + 1) || ':' || json_extract(header.value, '$.bubbleId')",
    " WHERE json_valid(bubble.value) AND (",
    referencedBubblePredicate,
    ")",
    "), 0)",
  ].join("");
}

interface SqliteCliUsabilityCacheEntry {
  canUse: boolean;
  checkedAt: number;
}

const SQLITE_CLI_NEGATIVE_CACHE_TTL_MS = 30_000;
const sqliteCliUsabilityCache = new Map<string, SqliteCliUsabilityCacheEntry>();

async function canUseSqliteCli(dbPath: string): Promise<boolean> {
  const cached = sqliteCliUsabilityCache.get(dbPath);
  if (cached?.canUse) return true;
  if (cached && Date.now() - cached.checkedAt < SQLITE_CLI_NEGATIVE_CACHE_TTL_MS) return false;

  let canUse = false;
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", dbPath, "SELECT json_valid('{}') AS ok;"],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    const rows = JSON.parse(stdout.trim()) as Array<{ ok?: number }>;
    canUse = rows[0]?.ok === 1;
  } catch {
    canUse = false;
  }
  sqliteCliUsabilityCache.set(dbPath, { canUse, checkedAt: Date.now() });
  return canUse;
}

async function querySqliteCli(dbPath: string, sql: string): Promise<Record<string, any>[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    maxBuffer: SQLITE_CLI_MAX_BUFFER,
    timeout: SQLITE_CLI_QUERY_TIMEOUT_MS,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as Record<string, any>[];
}

async function querySqliteCliText(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, sql], {
    maxBuffer: SQLITE_CLI_MAX_BUFFER,
    timeout: SQLITE_CLI_QUERY_TIMEOUT_MS,
  });
  return stdout.replace(/\r?\n$/, "");
}

export function sqlJsRows(db: Database, sql: string): Record<string, any>[] {
  const result = db.exec(sql);
  if (!result.length) return [];
  const [{ columns, values }] = result;
  return values.map((row: unknown[]) => {
    const record: Record<string, any> = {};
    columns.forEach((column: string, index: number) => {
      record[column] = row[index];
    });
    return record;
  });
}

async function queryGlobalStateRows(
  globalStateDb: CachedGlobalStateDb,
  sql: string,
): Promise<Record<string, any>[]> {
  if (globalStateDb.backend === "sqlite-cli") {
    return querySqliteCli(globalStateDb.dbPath, sql);
  }
  return sqlJsRows(globalStateDb.db, sql);
}

async function queryCursorDiskKvRowsByKeys(
  db: CachedGlobalStateDb,
  keys: string[],
): Promise<Array<{ key: unknown; value: unknown }>> {
  if (keys.length === 0) return [];
  const uniqueKeys = [...new Set(keys)];
  const rows: Array<{ key: unknown; value: unknown }> = [];
  for (let i = 0; i < uniqueKeys.length; i += GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE) {
    const chunk = uniqueKeys.slice(i, i + GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE);
    const chunkRows = await queryGlobalStateRows(
      db,
      `SELECT key, value FROM cursorDiskKV WHERE key IN (${chunk.map(sqlString).join(",")})`,
    );
    for (const row of chunkRows) {
      if ("key" in row && "value" in row) rows.push({ key: row.key, value: row.value });
    }
  }
  return rows;
}

async function queryGlobalStateTextValue(
  globalStateDb: CachedGlobalStateDb,
  key: string,
): Promise<string | null> {
  if (globalStateDb.backend === "sqlite-cli") {
    const value = await querySqliteCliText(
      globalStateDb.dbPath,
      `SELECT CAST(value AS TEXT) FROM cursorDiskKV WHERE key = ${sqlString(key)} LIMIT 1`,
    );
    return value || null;
  }

  const rows = sqlJsRows(
    globalStateDb.db,
    `SELECT value FROM cursorDiskKV WHERE key = ${sqlString(key)} LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return valueToString(rows[0].value) || null;
}

async function queryGlobalStateItemTableTextValue(
  globalStateDb: CachedGlobalStateDb,
  key: string,
): Promise<string | null> {
  if (globalStateDb.backend === "sqlite-cli") {
    const value = await querySqliteCliText(
      globalStateDb.dbPath,
      `SELECT CAST(value AS TEXT) FROM ItemTable WHERE key = ${sqlString(key)} LIMIT 1`,
    ).catch(() => "");
    return value || null;
  }
  try {
    const rows = sqlJsRows(
      globalStateDb.db,
      `SELECT value FROM ItemTable WHERE key = ${sqlString(key)} LIMIT 1`,
    );
    return rows.length > 0 ? valueToString(rows[0].value) || null : null;
  } catch {
    return null;
  }
}

function parseComposerHeaders(raw: string | null): Map<string, CursorComposerHeader> {
  const index = new Map<string, CursorComposerHeader>();
  if (!raw) return index;
  const root = parseJson<Record<string, unknown>>(raw);
  const allComposers = Array.isArray(root?.allComposers) ? root.allComposers : [];
  for (const value of allComposers) {
    if (!value || typeof value !== "object") continue;
    const header = value as Record<string, unknown>;
    const composerId = typeof header.composerId === "string" ? header.composerId.trim() : "";
    if (!composerId) continue;
    const rawInfo =
      header.subagentInfo && typeof header.subagentInfo === "object"
        ? (header.subagentInfo as Record<string, unknown>)
        : undefined;
    const parentComposerId =
      typeof rawInfo?.parentComposerId === "string" ? rawInfo.parentComposerId.trim() : "";
    const toolCallId = typeof rawInfo?.toolCallId === "string" ? rawInfo.toolCallId.trim() : "";
    index.set(composerId, {
      composerId,
      isSubagent: header.isSubagent === true || !!parentComposerId,
      ...(rawInfo
        ? {
            subagentInfo: {
              ...(parentComposerId ? { parentComposerId } : {}),
              ...(toolCallId ? { toolCallId } : {}),
            },
          }
        : {}),
    });
  }
  return index;
}

async function loadComposerHeaders(
  globalStateDb: CachedGlobalStateDb,
): Promise<Map<string, CursorComposerHeader>> {
  if (
    cachedComposerHeaders?.dbPath === globalStateDb.dbPath &&
    cachedComposerHeaders.size === globalStateDb.size &&
    cachedComposerHeaders.mtimeMs === globalStateDb.mtimeMs &&
    cachedComposerHeaders.walSize === globalStateDb.walSize &&
    cachedComposerHeaders.walMtimeMs === globalStateDb.walMtimeMs
  ) {
    return cachedComposerHeaders.headers;
  }
  const raw =
    (await queryGlobalStateItemTableTextValue(globalStateDb, "composer.composerHeaders")) ||
    (await queryGlobalStateTextValue(globalStateDb, "composerHeaders"));
  const headers = parseComposerHeaders(raw);
  cachedComposerHeaders = {
    dbPath: globalStateDb.dbPath,
    size: globalStateDb.size,
    mtimeMs: globalStateDb.mtimeMs,
    walSize: globalStateDb.walSize,
    walMtimeMs: globalStateDb.walMtimeMs,
    headers,
  };
  return headers;
}

async function openGlobalStateDb(): Promise<CachedGlobalStateDb | null> {
  const dbPath = await findGlobalStateDb();
  if (!dbPath) return null;

  const dbStat = await stat(dbPath).catch(() => null);
  if (!dbStat?.isFile() || dbStat.size < MIN_STORE_DB_SIZE) return null;
  const walFingerprint = await globalStateWalFingerprint(dbPath);

  if (
    cachedGlobalStateDb &&
    cachedGlobalStateDb.dbPath === dbPath &&
    cachedGlobalStateDb.size === dbStat.size &&
    cachedGlobalStateDb.mtimeMs === dbStat.mtimeMs &&
    cachedGlobalStateDb.walSize === walFingerprint.walSize &&
    cachedGlobalStateDb.walMtimeMs === walFingerprint.walMtimeMs
  ) {
    return cachedGlobalStateDb;
  }

  if (await canUseSqliteCli(dbPath)) {
    closeCachedSqlJsDb();
    cachedGlobalStateDb = {
      dbPath,
      backend: "sqlite-cli",
      size: dbStat.size,
      mtimeMs: dbStat.mtimeMs,
      ...walFingerprint,
    };
    return cachedGlobalStateDb;
  }

  let SQL: SqlJsStatic;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }

  const dbBuffer = await readFile(dbPath).catch(() => null);
  if (!dbBuffer) return null;

  const db = new SQL.Database(dbBuffer);
  closeCachedSqlJsDb();
  cachedGlobalStateDb = {
    dbPath,
    backend: "sqljs",
    db,
    size: dbStat.size,
    mtimeMs: dbStat.mtimeMs,
    ...walFingerprint,
  };
  return cachedGlobalStateDb;
}

async function hasGlobalStateSession(
  globalStateDb: CachedGlobalStateDb,
  sessionId: string,
): Promise<boolean> {
  const rows = await queryGlobalStateRows(
    globalStateDb,
    `SELECT 1 AS present FROM cursorDiskKV WHERE key = ${sqlString(
      `composerData:${sessionId}`,
    )} LIMIT 1`,
  );
  return rows.length > 0;
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

/**
 * Build a cheap freshness token for Cursor's split storage. A shared global
 * state component deliberately invalidates all Cursor sessions when the global
 * database changes: it is the only reliable signal for late tool results and
 * conversation summaries that may not touch the transcript or store.db.
 */
export async function getCursorSessionFingerprints(
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const storeIndex = await getStoreDbIndex();
  const globalStateDb = await openGlobalStateDb();
  const globalPart = globalStateDb
    ? [
        globalStateDb.dbPath,
        globalStateDb.size,
        globalStateDb.mtimeMs,
        globalStateDb.walSize,
        globalStateDb.walMtimeMs,
      ].join(":")
    : "no-global-state";

  const entries = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const store = storeIndex.get(sessionId);
      const wal = store ? await stat(`${store.dbPath}-wal`).catch(() => null) : null;
      const storePart = store
        ? [store.dbPath, store.size, store.mtimeMs, wal?.size || 0, wal?.mtimeMs || 0].join(":")
        : "no-store-db";
      const fingerprint = createHash("sha1")
        .update(`${sessionId}|${globalPart}|${storePart}`)
        .digest("hex")
        .slice(0, 20);
      return [sessionId, fingerprint] as const;
    }),
  );
  return new Map(entries);
}

async function existingPath(path: string): Promise<string | null> {
  const s = await stat(path).catch(() => null);
  return s ? path : null;
}

/**
 * Files that should wake Cursor live mode promptly when SQLite-backed data changes.
 *
 * Cursor often writes active conversation state into SQLite WAL files before the
 * main DB mtime moves. These paths are triggers only; parsing still goes through
 * the normal SQLite/global-state reader so we keep one source of truth.
 */
export async function resolveCursorLiveWatchPaths(sessionId: string): Promise<string[]> {
  const paths = new Set<string>();

  const addIfExists = async (path: string) => {
    const existing = await existingPath(path);
    if (existing) paths.add(existing);
  };

  const storeDb = await findStoreDb(sessionId);
  if (storeDb) {
    await addIfExists(storeDb);
    await addIfExists(`${storeDb}-wal`);
    // Session-scoped directory catches WAL creation when it does not exist yet.
    await addIfExists(dirname(storeDb));
  }

  const globalStateDb = await openGlobalStateDb();
  if (globalStateDb && (await hasGlobalStateSession(globalStateDb, sessionId))) {
    await addIfExists(globalStateDb.dbPath);
    const beforeWal = paths.size;
    await addIfExists(`${globalStateDb.dbPath}-wal`);
    // The global WAL may be created lazily. Watch the directory only when there
    // is no WAL file to watch yet; otherwise the shared globalStorage folder is
    // noisier than the specific SQLite files.
    if (paths.size === beforeWal) {
      await addIfExists(dirname(globalStateDb.dbPath));
    }
  }

  return [...paths];
}

export async function readCursorLiveDiagnostics(
  sessionId: string,
): Promise<CursorLiveDiagnostics | null> {
  const globalStateDb = await openGlobalStateDb();
  if (!globalStateDb || !(await hasGlobalStateSession(globalStateDb, sessionId))) return null;

  const rawComposer = await queryGlobalStateTextValue(globalStateDb, `composerData:${sessionId}`);
  const composer = parseJson<Record<string, any>>(rawComposer || "");
  if (!composer) return null;

  const headerBubbleIds = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
        .map((header: any) =>
          header && typeof header === "object" && typeof header.bubbleId === "string"
            ? header.bubbleId
            : "",
        )
        .filter(Boolean)
    : Array.isArray(composer.conversation)
      ? composer.conversation
          .map((item: any) =>
            item && typeof item === "object" && typeof item.bubbleId === "string"
              ? item.bubbleId
              : "",
          )
          .filter(Boolean)
      : [];
  const latestBubbleId = headerBubbleIds[headerBubbleIds.length - 1];

  const bubbleRows: Record<string, any>[] = [];
  const bubbleKeys = headerBubbleIds.map((bubbleId) => `bubbleId:${sessionId}:${bubbleId}`);
  for (let i = 0; i < bubbleKeys.length; i += GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE) {
    const chunk = bubbleKeys.slice(i, i + GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE);
    bubbleRows.push(
      ...(await queryGlobalStateRows(
        globalStateDb,
        [
          "SELECT",
          "key,",
          "length(value) AS bytes,",
          "json_extract(value,'$.type') AS type,",
          "json_extract(value,'$.text') AS text,",
          "json_extract(value,'$.createdAt') AS createdAt,",
          "json_extract(value,'$.lastUpdatedAt') AS lastUpdatedAt,",
          "json_extract(value,'$.toolFormerData.name') AS toolName,",
          "json_extract(value,'$.toolFormerData.result') IS NOT NULL AS toolHasResult,",
          "length(json_extract(value,'$.toolFormerData.result')) AS toolResultLength",
          "FROM cursorDiskKV",
          `WHERE key IN (${chunk.map(sqlString).join(",")}) AND json_valid(value)`,
        ].join(" "),
      )),
    );
  }
  const bubbleRowsByKey = new Map(bubbleRows.map((row) => [valueToString(row.key), row]));
  const latest = latestBubbleId
    ? bubbleRowsByKey.get(`bubbleId:${sessionId}:${latestBubbleId}`) || {}
    : {};
  const latestToolName = valueToString(latest.toolName).trim();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let pendingToolCount = 0;
  let maxBubbleBytes = 0;
  let totalBubbleBytes = 0;
  for (const row of bubbleRows) {
    const bytes = toNonNegativeInt(row.bytes);
    maxBubbleBytes = Math.max(maxBubbleBytes, bytes);
    totalBubbleBytes += bytes;
    if (!valueToString(row.toolName)) continue;
    toolCallCount++;
    if (Number(row.toolHasResult)) {
      toolResultCount++;
    } else {
      pendingToolCount++;
    }
  }
  const wal = await globalStateWalFingerprint(globalStateDb.dbPath);

  const diagnostics: CursorLiveDiagnostics = {
    source: "global-state",
    probedAt: new Date().toISOString(),
    dbPath: globalStateDb.dbPath,
    dbMtimeMs: Math.round(globalStateDb.mtimeMs),
    walMtimeMs: Math.round(wal.walMtimeMs),
    walSize: Math.round(wal.walSize),
    composerBytes: rawComposer ? Buffer.byteLength(rawComposer, "utf-8") : 0,
    headerCount: headerBubbleIds.length,
    ...(toIsoTimestamp(composer.lastUpdatedAt)
      ? { composerLastUpdatedAt: toIsoTimestamp(composer.lastUpdatedAt) }
      : {}),
    ...(latestBubbleId ? { latestBubbleId } : {}),
    ...(toIsoTimestamp(latest.createdAt)
      ? { latestBubbleCreatedAt: toIsoTimestamp(latest.createdAt) }
      : {}),
    ...(toIsoTimestamp(latest.lastUpdatedAt)
      ? { latestBubbleUpdatedAt: toIsoTimestamp(latest.lastUpdatedAt) }
      : {}),
    ...(typeof latest.type === "number" ? { latestBubbleType: latest.type } : {}),
    ...(valueToString(latest.text).trim()
      ? { latestTextPreview: valueToString(latest.text).replace(/\s+/g, " ").trim().slice(0, 160) }
      : {}),
    ...(latestToolName ? { latestToolName } : {}),
    ...(latestToolName && latest.toolHasResult !== undefined
      ? { latestToolHasResult: Number(latest.toolHasResult) !== 0 }
      : {}),
    ...(latest.toolResultLength !== null && latest.toolResultLength !== undefined
      ? { latestToolResultLength: toNonNegativeInt(latest.toolResultLength) }
      : {}),
    bubbleCount: bubbleRows.length,
    toolCallCount,
    toolResultCount,
    pendingToolCount,
    maxBubbleBytes,
    totalBubbleBytes,
    signature: "",
  };
  diagnostics.signature = cursorLiveDiagnosticsSignature(diagnostics);
  return diagnostics;
}

function cursorLiveDiagnosticsSignature(
  diagnostics: Omit<CursorLiveDiagnostics, "signature">,
): string {
  return [
    diagnostics.headerCount,
    diagnostics.bubbleCount,
    diagnostics.toolCallCount,
    diagnostics.toolResultCount,
    diagnostics.pendingToolCount,
    diagnostics.composerBytes,
    diagnostics.composerLastUpdatedAt || "",
    diagnostics.latestBubbleId || "",
    diagnostics.latestBubbleCreatedAt || "",
    diagnostics.latestBubbleUpdatedAt || "",
    diagnostics.latestToolName || "",
    diagnostics.latestToolHasResult ? "1" : "0",
    diagnostics.latestToolResultLength ?? "",
    diagnostics.totalBubbleBytes,
  ].join("|");
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

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return parseJson(value) ?? value;
}

function optionalJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  return parseJsonColumn(value);
}

function projectedCursorBubbleRowToBubble(row: Record<string, any>): Record<string, any> | null {
  const key = valueToString(row.key);
  if (!key) return null;
  const bubble: Record<string, any> = {
    bubbleId: key.slice(key.lastIndexOf(":") + 1),
  };

  for (const field of [
    "type",
    "text",
    "createdAt",
    "lastUpdatedAt",
    "thinkingDurationMs",
    "modelName",
    "retryAttempt",
  ] as const) {
    if (row[field] !== null && row[field] !== undefined) bubble[field] = row[field];
  }

  for (const field of [
    "thinking",
    "timingInfo",
    "tokenCount",
    "modelInfo",
    "modelConfig",
    "pullRequests",
    "errorDetails",
    "relevantFiles",
    "recentlyViewedFiles",
  ] as const) {
    const value = optionalJsonColumn(row[field]);
    if (value !== undefined) bubble[field] = value;
  }

  if (row.toolName) {
    const result =
      typeof row.toolResult === "string" ? row.toolResult : valueToString(row.toolResult);
    const parsedResultLength = Number(row.toolResultLength);
    const resultLength = Number.isFinite(parsedResultLength) ? parsedResultLength : result.length;
    const hasResult =
      row.toolHasResult === undefined
        ? row.toolResult !== null && row.toolResult !== undefined
        : Number(row.toolHasResult) !== 0;
    bubble.toolFormerData = {
      name: valueToString(row.toolName),
      ...(row.toolParams !== null && row.toolParams !== undefined
        ? { params: optionalJsonColumn(row.toolParams) ?? row.toolParams }
        : {}),
      ...(hasResult
        ? {
            result:
              resultLength > MAX_CURSOR_GLOBAL_STATE_TOOL_RESULT_CHARS
                ? `${result}\n... (truncated by vibe-replay, ${resultLength} chars total)`
                : result,
          }
        : {}),
      ...(row.toolCallId ? { toolCallId: valueToString(row.toolCallId) } : {}),
    };
  }

  return bubble;
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

function toPlausibleCursorTimestamp(value: unknown): string | undefined {
  const iso = toIsoTimestamp(value);
  if (!iso) return undefined;
  const timestampMs = Date.parse(iso);
  // Cursor's timingInfo.clientStartTime is sometimes elapsed milliseconds
  // since the request began, not an epoch timestamp. Do not turn that value
  // into a fake 1970 session start.
  return timestampMs >= Date.UTC(2000, 0, 1) ? iso : undefined;
}

function cursorComposerSidecarMetadata(composer: Record<string, any>): CursorSidecars | undefined {
  const conversationCheckpointLastUpdatedAt = toIsoTimestamp(
    composer.conversationCheckpointLastUpdatedAt,
  );
  const restrictAgentModeSwitching =
    typeof composer.restrictAgentModeSwitching === "boolean"
      ? composer.restrictAgentModeSwitching
      : undefined;
  const glassMetaParentAgent =
    typeof composer.glassMetaParentAgent === "string"
      ? composer.glassMetaParentAgent.trim()
      : undefined;

  const metadata: CursorSidecars = {
    ...(conversationCheckpointLastUpdatedAt ? { conversationCheckpointLastUpdatedAt } : {}),
    ...(restrictAgentModeSwitching !== undefined ? { restrictAgentModeSwitching } : {}),
    ...(glassMetaParentAgent ? { glassMetaParentAgent } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function maxIsoTimestamp(values: Array<unknown>): string | undefined {
  let maxMs: number | undefined;
  for (const value of values) {
    const iso = toIsoTimestamp(value);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (maxMs === undefined || ms > maxMs) maxMs = ms;
  }
  return maxMs === undefined ? undefined : new Date(maxMs).toISOString();
}

function minIsoTimestamp(values: Array<unknown>): string | undefined {
  let minMs: number | undefined;
  for (const value of values) {
    const iso = toIsoTimestamp(value);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (minMs === undefined || ms < minMs) minMs = ms;
  }
  return minMs === undefined ? undefined : new Date(minMs).toISOString();
}

function bubbleTimestamp(bubble: Record<string, any>): string | undefined {
  const timingInfo =
    bubble.timingInfo && typeof bubble.timingInfo === "object"
      ? (bubble.timingInfo as Record<string, any>)
      : undefined;
  return (
    toPlausibleCursorTimestamp(bubble.createdAt) ||
    toPlausibleCursorTimestamp(bubble.lastUpdatedAt) ||
    toPlausibleCursorTimestamp(timingInfo?.clientStartTime) ||
    toPlausibleCursorTimestamp(timingInfo?.clientEndTime) ||
    toPlausibleCursorTimestamp(timingInfo?.clientSettleTime)
  );
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

function normalizeComposerPath(pathValue: string): string {
  return pathValue
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, (slashes, offset) => (offset === 0 ? "//" : "/"))
    .replace(/[)"',]+$/g, "");
}

function composerSearchableData(rawComposerData: string): string {
  return rawComposerData.replaceAll("\\\\", "\\").replace(/\\"/g, '"').replace(/\\\//g, "/");
}

function isAbsoluteComposerPath(pathValue: string): boolean {
  return pathValue.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(pathValue);
}

function composerPathRoot(pathValue: string): string {
  if (WINDOWS_ABSOLUTE_PATH_RE.test(pathValue)) return `${pathValue.slice(0, 2)}/`;
  if (UNC_PATH_RE.test(pathValue)) {
    const parts = pathValue.split("/").filter(Boolean);
    if (parts.length >= 2) return `//${parts[0]}/${parts[1]}`;
    return "//";
  }
  return "/";
}

function composerPathBasename(pathValue: string): string {
  return posix.basename(normalizeComposerPath(pathValue));
}

function composerPathBasenameKey(pathValue: string): string {
  const normalized = normalizeComposerPath(pathValue);
  const value = composerPathBasename(normalized);
  return /^[A-Za-z]:\/|^\/\//.test(normalized) ? value.toLowerCase() : value;
}

async function resolveProjectRootFromPath(rawPath: string): Promise<string | null> {
  const candidate = normalizeComposerPath(rawPath)
    .replace(/\\n.*$/, "")
    .replace(/["']+$/g, "");
  if (!isAbsoluteComposerPath(candidate)) return null;

  const cached = resolvedProjectRootCache.get(candidate);
  if (cached) return cached;

  const resolving = (async () => {
    let current = candidate;
    const root = composerPathRoot(candidate);
    const initial = await stat(current).catch(() => null);
    if (initial?.isFile()) current = dirname(current);

    let deepestExisting: string | null = null;
    while (current && current !== root) {
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
  const fastProject = inferProjectFromComposerDataFast(rawComposerData, decodedWorkspacePaths);
  if (fastProject) return fastProject;

  const hintedRoots = extractComposerProjectRootHints(rawComposerData);
  for (const hint of hintedRoots) {
    const resolved = await resolveProjectRootFromPath(hint);
    if (resolved && !isLowSignalProjectRoot(resolved)) return resolved;
  }

  const searchable = composerSearchableData(rawComposerData);
  const matches =
    searchable.match(/\/(?:Users|home|workspace|workspaces|tmp)\/[^"'\s,}{]{1,240}/g) || [];
  const windowsMatches =
    searchable.match(
      /[A-Za-z]:[\\/](?:Users|home|workspace|workspaces|tmp)[\\/][^"'\s,}{]{1,240}/gi,
    ) || [];
  const uncMatches = searchable.match(/(?:\\\\|\/\/)[^"'\s,}{]+[\\/][^"'\s,}{]{1,240}/g) || [];
  for (const match of [...matches, ...windowsMatches, ...uncMatches]) {
    const resolved = await resolveProjectRootFromPath(match);
    if (resolved && !isLowSignalProjectRoot(resolved)) return resolved;
  }
  return "";
}

function inferProjectFromComposerDataFast(
  rawComposerData: string,
  decodedWorkspacePaths: string[],
): string {
  const uniqueDecoded = [...new Set(decodedWorkspacePaths.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const workspacePath of uniqueDecoded) {
    const normalized = normalizeComposerPath(workspacePath);
    const variants = [
      workspacePath,
      normalized,
      normalized.replace(/^\//, ""),
      workspacePath.replaceAll("\\", "\\\\"),
    ];
    const isWindowsPath = /^[A-Za-z]:[\\/]|^(?:\\\\|\/\/)/.test(workspacePath);
    const source = isWindowsPath ? rawComposerData.toLowerCase() : rawComposerData;
    if (
      variants.some((variant) => source.includes(isWindowsPath ? variant.toLowerCase() : variant))
    ) {
      return workspacePath;
    }
  }

  const hintedRoots = extractComposerProjectRootHints(rawComposerData);
  const basenameMatches = new Map<string, string[]>();
  for (const workspacePath of uniqueDecoded) {
    const key = composerPathBasenameKey(workspacePath);
    if (!key) continue;
    const existing = basenameMatches.get(key) || [];
    existing.push(workspacePath);
    basenameMatches.set(key, existing);
  }

  const bestHint = hintedRoots.find((hint) => !isLowSignalProjectRoot(hint));
  if (bestHint) {
    const matchingDecoded = basenameMatches.get(composerPathBasenameKey(bestHint)) || [];
    if (matchingDecoded.length === 1) return matchingDecoded[0];
    if (canUseComposerProjectHintDirectly(bestHint)) return bestHint;
  }

  for (const hint of hintedRoots) {
    const matchingDecoded = basenameMatches.get(composerPathBasenameKey(hint)) || [];
    if (matchingDecoded.length === 1) return matchingDecoded[0];

    if (canUseComposerProjectHintDirectly(hint)) return hint;
  }

  if (bestHint) return bestHint;
  return "";
}

function extractComposerProjectRootHints(rawComposerData: string): string[] {
  const searchable = composerSearchableData(rawComposerData);
  const explicitCwdRoots = [...searchable.matchAll(/"cwd"\s*:\s*"([^"]+)"/g)]
    .map((match) => inferProjectRootFromPathHint(match[1], { allowWorkspaceRoot: true }))
    .filter((value): value is string => Boolean(value));
  const matches =
    searchable.match(/\/(?:Users|home|workspace|workspaces|tmp)\/[^"'\\\s,}{]{0,240}/g) || [];
  const windowsMatches =
    searchable.match(
      /[A-Za-z]:[\\/](?:Users|home|workspace|workspaces|tmp)[\\/][^"'\s,}{]{0,240}/gi,
    ) || [];
  const uncMatches =
    searchable.match(/(?<![A-Za-z]:)(?:\\\\|\/\/)[^"'\s,}{]+[\\/][^"'\s,}{]{0,240}/g) || [];
  const roots = [...matches, ...windowsMatches, ...uncMatches]
    .map((match) => inferProjectRootFromPathHint(match))
    .filter((value): value is string => Boolean(value));
  return [...new Set([...explicitCwdRoots, ...roots])].sort((a, b) => b.length - a.length);
}

function inferProjectRootFromPathHint(
  pathValue: string,
  options?: { allowWorkspaceRoot?: boolean },
): string | null {
  const normalized = normalizeComposerPath(pathValue);
  if (!isAbsoluteComposerPath(normalized)) return null;

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

  const workspaceMatch = normalized.match(/^(\/|[A-Za-z]:\/)(workspace|workspaces)\/([^/]+)/i);
  if (workspaceMatch?.[3] && !workspaceMatch[3].startsWith(".")) {
    return `${workspaceMatch[1]}${workspaceMatch[2]}/${workspaceMatch[3]}`;
  }
  if (options?.allowWorkspaceRoot && /^(?:\/|[A-Za-z]:\/)workspaces?\/?$/i.test(normalized)) {
    return normalized.replace(/\/$/, "");
  }

  const parts = normalized.split("/").filter(Boolean);
  const driveOffset = /^[A-Za-z]:$/.test(parts[0] || "") ? 1 : 0;
  const namespace = parts[driveOffset]?.toLowerCase();
  if (namespace === "users" && parts.length >= driveOffset + 4) {
    const rootLength = driveOffset + 4;
    return `${normalized.startsWith("//") ? "//" : driveOffset ? "" : "/"}${parts
      .slice(0, rootLength)
      .join("/")}`;
  }
  if (
    namespace === "home" &&
    parts.length >= driveOffset + 3 &&
    !parts[driveOffset + 2]?.startsWith(".")
  ) {
    const rootLength = driveOffset + 3;
    return `${normalized.startsWith("//") ? "//" : driveOffset ? "" : "/"}${parts
      .slice(0, rootLength)
      .join("/")}`;
  }
  if (normalized.startsWith("//") && parts.length >= 3) {
    return `//${parts.slice(0, 3).join("/")}`;
  }
  return null;
}

function isLowSignalProjectRoot(pathValue: string): boolean {
  const normalized = pathValue.replace(/^[A-Za-z]:/, "");
  return (
    normalized === "/home" ||
    normalized === "/tmp" ||
    normalized === "/workspace" ||
    normalized === "/workspaces" ||
    /^\/home\/[^/]+$/i.test(normalized)
  );
}

function canUseComposerProjectHintDirectly(pathValue: string): boolean {
  return (
    /^(?:\/|[A-Za-z]:\/)workspaces?$/i.test(pathValue) ||
    /^(?:\/|[A-Za-z]:\/)workspaces\/[^/]+$/i.test(pathValue) ||
    /^(?:\/|[A-Za-z]:\/)workspace\/[^/]+$/i.test(pathValue) ||
    /^(?:\/|[A-Za-z]:\/)home\/[^/]+\/[^/]+$/i.test(pathValue) ||
    /^(?:\/|[A-Za-z]:\/)Users\/[^/]+\/[^/]+\/[^/]+$/i.test(pathValue)
  );
}

function hasReplayableRootBlob(data: unknown): boolean {
  if (!(data instanceof Uint8Array) || data.length === 0) return false;
  return (
    extractChildBlobIds(data).length > 0 || extractAgentKvBlobIds(valueToString(data)).length > 0
  );
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
  let SQL: SqlJsStatic;
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
    const meta = parseChatMetaHex(metaHex);
    const rootId = meta.latestRootBlobId;
    if (!rootId) return { meta, hasReplayableRoot: false };
    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) {
      return { meta, hasReplayableRoot: false };
    }
    const rootData = rootRows[0].values[0][0];
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
  const candidates = [...storeDbIndex.values()].filter(
    (entry) => !knownSessionIds.has(entry.sessionId),
  );
  const metadataConcurrency = 8;

  for (let offset = 0; offset < candidates.length; offset += metadataConcurrency) {
    const batch = candidates.slice(offset, offset + metadataConcurrency);
    const previews = await Promise.all(
      batch.map(async (entry) => ({
        entry,
        metaPreview: await readStoreDbMeta(entry.dbPath),
      })),
    );
    for (const { entry, metaPreview } of previews) {
      if (!metaPreview?.hasReplayableRoot) continue;
      const meta = metaPreview.meta;

      const project = hashToProject.get(entry.workspaceHash) || "";
      const firstPrompt = meta.name || "(sqlite-only session)";
      const timestamp = toIsoTimestamp(meta.createdAt) || new Date(entry.mtimeMs).toISOString();

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
  }

  return sessions;
}

export interface GlobalStateDiscoveryResult {
  sessions: SessionInfo[];
  sessionIds: Set<string>;
  /** All replayable global-state sessions, including IDs already found in transcripts. */
  allSessions: SessionInfo[];
}

export function countComposerConversationHeaders(composer: Record<string, any>): number {
  const fullHeaders = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly.length
    : 0;
  const legacyConversation = Array.isArray(composer.conversation)
    ? composer.conversation.length
    : 0;
  return Math.max(fullHeaders, legacyConversation);
}

function cursorLatestSummaryText(composer: Record<string, any>): string | undefined {
  const latest = composer.latestConversationSummary;
  if (!latest || typeof latest !== "object") return undefined;
  const summary = (latest as Record<string, any>).summary;
  if (typeof summary === "string" && summary.trim()) return summary;
  if (summary && typeof summary === "object") {
    const text = (summary as Record<string, any>).summary;
    if (typeof text === "string" && text.trim()) return text;
  }
  return undefined;
}

/**
 * Cursor keeps the latest compaction summary on composerData rather than a
 * durable event list. Treat its presence as one known compaction and expose
 * the result as a lower bound; older summaries may have been overwritten.
 */
export function cursorCompactionCount(composer: Record<string, any>): number {
  return cursorLatestSummaryText(composer) ? 1 : 0;
}

export function cursorCompactions(
  composer: Record<string, any>,
  fallbackTimestamp?: string,
): Compaction[] | undefined {
  if (!cursorLatestSummaryText(composer)) return undefined;
  const latest = composer.latestConversationSummary as Record<string, any>;
  const summary =
    latest.summary && typeof latest.summary === "object"
      ? (latest.summary as Record<string, any>)
      : latest;
  const timestamp =
    maxIsoTimestamp([
      latest.createdAt,
      latest.created_at,
      latest.timestamp,
      latest.lastUpdatedAt,
      summary.createdAt,
      summary.created_at,
      summary.timestamp,
      composer.lastUpdatedAt,
      composer.createdAt,
    ]) ||
    fallbackTimestamp ||
    new Date().toISOString();
  return [
    {
      timestamp,
      trigger: "cursor-context",
      accuracy: "lower-bound",
    },
  ];
}

function composerHeaderBubbleIds(composer: Record<string, any>): string[] {
  if (!Array.isArray(composer.fullConversationHeadersOnly)) return [];
  return [
    ...new Set(
      composer.fullConversationHeadersOnly
        .map((header: any) =>
          header && typeof header === "object" && typeof header.bubbleId === "string"
            ? header.bubbleId
            : "",
        )
        .filter((bubbleId: string) => Boolean(bubbleId)),
    ),
  ];
}

function isReplayableGlobalStateBubble(bubble: Record<string, any>): boolean {
  return bubbleToTurn(bubble) !== null;
}

async function hasReplayableGlobalStateComposer(
  globalStateDb: CachedGlobalStateDb,
  sessionId: string,
  composer: Record<string, any>,
): Promise<boolean> {
  if (
    Array.isArray(composer.conversation) &&
    composer.conversation.some(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        isReplayableGlobalStateBubble(item as Record<string, any>),
    )
  ) {
    return true;
  }

  const bubbleIds = composerHeaderBubbleIds(composer);
  if (bubbleIds.length === 0) return false;

  const rows = await loadProjectedBubbleRowsByKeys(
    globalStateDb,
    bubbleIds.map((bubbleId) => `bubbleId:${sessionId}:${bubbleId}`),
  );
  return rows.some((row) => {
    const bubble = projectedCursorBubbleRowToBubble(row);
    return bubble ? isReplayableGlobalStateBubble(bubble) : false;
  });
}

function firstUserTextSnippet(turns: ParsedTurn[]): string | undefined {
  const firstUser = turns.find((t) => t.role === "user");
  const firstText = firstUser?.blocks.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return firstText?.text.slice(0, 80);
}

function finalizeGlobalStateDiscovery(
  discoveredSessions: SessionInfo[],
  knownSessionIds: Set<string>,
): SessionInfo[] {
  const finalSessions = discoveredSessions.filter(
    (session) => !knownSessionIds.has(session.sessionId),
  );
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
  if (!globalStateDb) return { sessions: [], sessionIds, allSessions: [] };
  const { dbPath } = globalStateDb;
  const decodedPathsHash = hashWorkspacePaths(decodedWorkspacePaths);
  const cacheKey = `${GLOBAL_STATE_DISCOVERY_CACHE_PREFIX}-${decodedPathsHash}`;

  const cached = await readFileCache<GlobalStateDiscoveryCache>(cacheKey);
  if (
    cached?.data.dbPath === dbPath &&
    cached.data.size === globalStateDb.size &&
    cached.data.mtimeMs === globalStateDb.mtimeMs &&
    (cached.data.walSize ?? 0) === globalStateDb.walSize &&
    (cached.data.walMtimeMs ?? 0) === globalStateDb.walMtimeMs &&
    cached.data.decodedPathsHash === decodedPathsHash
  ) {
    const cachedIds = new Set(cached.data.sessionIds);
    return {
      sessions: finalizeGlobalStateDiscovery(cached.data.sessions, knownSessionIds),
      sessionIds: cachedIds,
      allSessions: cached.data.sessions,
    };
  }

  const discoveredSessions: SessionInfo[] = [];
  const composerHeaders = await loadComposerHeaders(globalStateDb);

  try {
    const composerDiscoverySql =
      globalStateDb.backend === "sqlite-cli"
        ? [
            "SELECT kv.key,",
            "MAX(COALESCE(json_array_length(kv.value,'$.fullConversationHeadersOnly'),0),",
            "COALESCE(json_array_length(kv.value,'$.conversation'),0)) AS headerCount,",
            "json_extract(kv.value,'$.lastUpdatedAt') AS lastUpdatedAt,",
            "json_extract(kv.value,'$.createdAt') AS createdAt,",
            "json_extract(kv.value,'$.name') AS title,",
            "CASE WHEN json_type(kv.value,'$.latestConversationSummary.summary.summary') = 'text'",
            "AND length(trim(json_extract(kv.value,'$.latestConversationSummary.summary.summary'))) > 0",
            "THEN 1 ELSE 0 END AS hasLatestConversationSummary,",
            "length(kv.value) AS fileSize,",
            `${replayableGlobalStateBubbleCountSql("kv.value", "kv.key")} AS replayableBubbleCount`,
            `FROM cursorDiskKV AS kv WHERE ${sqlKeyPrefixRange(
              "composerData:",
              "kv.key",
            )} AND json_valid(kv.value)`,
          ].join(" ")
        : `SELECT key, value FROM cursorDiskKV WHERE ${sqlKeyPrefixRange("composerData:")}`;
    const rows = await queryGlobalStateRows(globalStateDb, composerDiscoverySql);
    if (rows.length === 0) return { sessions: [], sessionIds, allSessions: [] };

    for (const row of rows) {
      const key = valueToString(row.key);
      const sessionId = key.startsWith("composerData:") ? key.slice("composerData:".length) : "";
      if (!SESSION_ID_RE.test(sessionId)) continue;
      if (composerHeaders.get(sessionId)?.isSubagent) continue;

      const rawComposer = row.value === undefined ? "" : valueToString(row.value);
      const composer = rawComposer ? parseJson<Record<string, any>>(rawComposer) : null;
      if (rawComposer && !composer) continue;
      const headerCount = composer
        ? countComposerConversationHeaders(composer)
        : toNonNegativeInt(row.headerCount);
      // Skip sessions without conversation headers: they cannot be replayed.
      if (headerCount === 0) continue;

      const hasReplayableBubble = composer
        ? await hasReplayableGlobalStateComposer(globalStateDb, sessionId, composer)
        : toNonNegativeInt(row.replayableBubbleCount) > 0;
      if (!hasReplayableBubble) continue;

      // Track only replayable global-state sessions for downstream hasSqlite marking.
      sessionIds.add(sessionId);

      const timestamp =
        toIsoTimestamp(composer?.lastUpdatedAt ?? row.lastUpdatedAt) ||
        toIsoTimestamp(composer?.createdAt ?? row.createdAt) ||
        new Date().toISOString();
      const title =
        typeof (composer?.name ?? row.title) === "string" &&
        valueToString(composer?.name ?? row.title).trim()
          ? valueToString(composer?.name ?? row.title).trim()
          : undefined;
      const firstPrompt = title || "(cursor global state session)";
      const projectPath = rawComposer
        ? inferProjectFromComposerDataFast(rawComposer, decodedWorkspacePaths)
        : "";

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
        fileSize: rawComposer
          ? Buffer.byteLength(rawComposer, "utf-8")
          : toNonNegativeInt(row.fileSize),
        filePath: `${dbPath}#composerData:${sessionId}`,
        filePaths: [],
        workspacePath: projectPath,
        hasSqlite: true,
        firstPrompt,
        compactionCount: composer
          ? cursorCompactionCount(composer)
          : toNonNegativeInt(row.hasLatestConversationSummary),
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
    walSize: globalStateDb.walSize,
    walMtimeMs: globalStateDb.walMtimeMs,
    decodedPathsHash,
    sessions: discoveredSessions,
    sessionIds: [...sessionIds],
  });

  return {
    sessions: finalizeGlobalStateDiscovery(discoveredSessions, knownSessionIds),
    sessionIds,
    allSessions: discoveredSessions,
  };
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

function parseChatMetaHex(hex: string): ChatMeta {
  return JSON.parse(Buffer.from(hex, "hex").toString("utf-8")) as ChatMeta;
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

interface CursorAgentKvBlobMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CursorBlock[];
  toolCallId?: string;
  tool_call_id?: string;
  toolName?: string;
  tool_name?: string;
  args?: Record<string, any>;
}

function extractAgentKvBlobIds(value: unknown): string[] {
  if (typeof value !== "string" || !value.includes(CURSOR_AGENTKV_BLOB_PREFIX)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /agentKv:blob:([a-f0-9]{64})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    const id = match[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function agentKvBlobMessageToCursorMessage(
  message: CursorAgentKvBlobMessage,
): CursorMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (!["system", "user", "assistant", "tool"].includes(message.role)) return undefined;
  const content =
    typeof message.content === "string" || Array.isArray(message.content) ? message.content : "";
  // Current agentKv blobs use the same block arrays as store.db messages.
  // Preserve them verbatim so text, reasoning and structured tool calls/results
  // flow through the established messagesToTurns path. Top-level fields below
  // remain as a fallback for older string-content blobs.
  if (Array.isArray(content)) {
    return { role: message.role, content };
  }
  if (message.role === "assistant") {
    const toolMessage = message as CursorAgentKvBlobMessage & {
      toolCallId?: string;
      toolName?: string;
      args?: Record<string, any>;
    };
    if (toolMessage.toolCallId && toolMessage.toolName) {
      return {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: toolMessage.toolCallId,
            toolName: toolMessage.toolName,
            args: toolMessage.args || {},
          },
        ],
      };
    }
  }
  if (message.role === "tool") {
    const toolMessage = message as CursorAgentKvBlobMessage & {
      toolCallId?: string;
      toolName?: string;
    };
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: toolMessage.toolCallId || "agentkv-tool-result",
          toolName: toolMessage.toolName || "CursorAgentKv",
          result: content,
        },
      ],
    };
  }
  return { role: message.role, content };
}

function appendAgentKvBlobMessages(
  messages: CursorMessage[],
  blobRows: Array<{ key: unknown; value: unknown }>,
): number {
  let appended = 0;
  let pendingToolCallId = "";
  let pendingToolName = "CursorAgentKv";
  for (const row of blobRows) {
    const raw = valueToString(row.value);
    const parsed = parseJson<CursorAgentKvBlobMessage>(raw);
    if (!parsed) continue;
    const toolCallId =
      parsed.toolCallId ||
      parsed.tool_call_id ||
      (parsed.role === "assistant"
        ? raw.match(/(?:toolCallId|tool_call_id)["'\s:=]+([A-Za-z0-9_-]+)/i)?.[1]
        : undefined);
    if (toolCallId) pendingToolCallId = toolCallId;
    const toolName =
      parsed.toolName ||
      parsed.tool_name ||
      (parsed.role === "assistant"
        ? raw.match(/(?:toolName|tool_name)["'\s:=]+([A-Za-z0-9_-]+)/i)?.[1]
        : undefined);
    if (toolName) pendingToolName = toolName;
    const message = agentKvBlobMessageToCursorMessage({
      ...parsed,
      ...(pendingToolCallId && parsed.role === "assistant" && toolCallId
        ? { toolCallId: pendingToolCallId, toolName: pendingToolName }
        : {}),
      ...(parsed.role === "tool"
        ? { toolCallId: pendingToolCallId, toolName: pendingToolName }
        : {}),
    } as CursorAgentKvBlobMessage & { toolCallId?: string; toolName?: string });
    if (!message) continue;
    messages.push(message);
    appended++;
    if (parsed.role === "tool") {
      pendingToolCallId = "";
      pendingToolName = "CursorAgentKv";
    }
  }
  return appended;
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
  workspacePath: string,
  sessionId: string,
): Promise<ProviderParseResult | null> {
  const storeResult = await parseCursorStoreDb(sessionId, workspacePath);
  if (storeResult) {
    // sql.js needs the whole DB loaded into memory, so the first global-state probe is expensive.
    // Keep the cheap composer-key existence check below so store-backed sessions avoid the full
    // enrichment parse when they do not actually exist in state.vscdb.
    const globalStateDb = await openGlobalStateDb();
    if (!globalStateDb || !(await hasGlobalStateSession(globalStateDb, sessionId))) {
      return storeResult;
    }
    const globalStateResult = await parseCursorGlobalStateDb(
      sessionId,
      globalStateDb,
      workspacePath,
    );
    return globalStateResult
      ? mergeCursorParseResults(storeResult, globalStateResult)
      : storeResult;
  }
  return parseCursorGlobalStateDb(sessionId, undefined, workspacePath);
}

async function parseCursorStoreDb(
  sessionId: string,
  workspacePath = "",
): Promise<ProviderParseResult | null> {
  const dbPath = await findStoreDb(sessionId);
  if (!dbPath) return null;

  if (await canUseSqliteCli(dbPath)) {
    try {
      return await parseCursorStoreDbWithSqliteCli(dbPath, sessionId, workspacePath);
    } catch {
      // Fall through to sql.js. Some machines may have sqlite3 installed but
      // unable to read this specific DB/WAL state in readonly mode.
    }
  }

  let SQL: SqlJsStatic;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }

  const dbBuffer = await readFile(dbPath);
  const db = new SQL.Database(dbBuffer);

  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;

    const metaHex = metaRows[0].values[0][0] as string;
    const metaJson = parseChatMetaHex(metaHex);
    const rootId = metaJson.latestRootBlobId;
    if (!rootId) return null;

    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) return null;

    const rootData = rootRows[0].values[0][0] as Uint8Array;
    const childIds = extractChildBlobIds(rootData);
    const agentKvBlobIds = extractAgentKvBlobIds(new TextDecoder().decode(rootData));
    if (childIds.length === 0 && agentKvBlobIds.length === 0) return null;

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

    if (agentKvBlobIds.length > 0) {
      try {
        const agentKvStmt = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key = ?");
        try {
          for (const id of agentKvBlobIds) {
            agentKvStmt.bind([`${CURSOR_AGENTKV_BLOB_PREFIX}${id}`]);
            if (agentKvStmt.step()) {
              const row = agentKvStmt.getAsObject() as Record<string, unknown>;
              appendAgentKvBlobMessages(messages, [{ key: row.key, value: row.value }]);
            }
            agentKvStmt.reset();
          }
        } finally {
          agentKvStmt.free();
        }
      } catch {
        // Older or session-scoped store.db files may not have cursorDiskKV.
      }
    }

    return buildCursorStoreResult(sessionId, workspacePath, metaJson, messages);
  } finally {
    db.close();
  }
}

async function parseCursorStoreDbWithSqliteCli(
  dbPath: string,
  sessionId: string,
  workspacePath: string,
): Promise<ProviderParseResult | null> {
  const metaRows = await querySqliteCli(dbPath, "SELECT value FROM meta WHERE key = '0'");
  const metaHex = typeof metaRows[0]?.value === "string" ? metaRows[0].value : "";
  if (!metaHex) return null;

  // If sqlite3 returns malformed data, let the caller fall back to the sql.js
  // path below; that path has historically handled store.db quirks well.
  const metaJson = parseChatMetaHex(metaHex);
  const rootId = metaJson.latestRootBlobId;
  if (!rootId) return null;

  const rootRows = await querySqliteCli(
    dbPath,
    `SELECT hex(data) AS dataHex FROM blobs WHERE id = ${sqlString(rootId)}`,
  );
  const rootDataHex = typeof rootRows[0]?.dataHex === "string" ? rootRows[0].dataHex : "";
  if (!rootDataHex) return null;

  const rootData = Buffer.from(rootDataHex, "hex");
  const childIds = extractChildBlobIds(rootData);
  const agentKvBlobIds = extractAgentKvBlobIds(rootData.toString("utf-8"));
  if (childIds.length === 0 && agentKvBlobIds.length === 0) return null;

  const blobHexById = new Map<string, string>();
  const chunkSize = 200;
  for (let i = 0; i < childIds.length; i += chunkSize) {
    const chunk = childIds.slice(i, i + chunkSize);
    // Keep the sqlite3 path WAL-aware by querying through SQLite itself. Chunk
    // the blob lookup so large conversations do not create huge IN clauses.
    const rows = await querySqliteCli(
      dbPath,
      `SELECT id, hex(data) AS dataHex FROM blobs WHERE id IN (${chunk.map(sqlString).join(",")})`,
    );
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.dataHex === "string") {
        blobHexById.set(row.id, row.dataHex);
      }
    }
  }

  const messages: CursorMessage[] = [];
  for (const cid of childIds) {
    const dataHex = blobHexById.get(cid);
    if (!dataHex) continue;
    try {
      const text = Buffer.from(dataHex, "hex").toString("utf-8");
      messages.push(JSON.parse(text));
    } catch {
      // binary or corrupted blob, skip
    }
  }

  if (agentKvBlobIds.length > 0) {
    try {
      const rows = await querySqliteCli(
        dbPath,
        `SELECT key, value FROM cursorDiskKV WHERE key IN (${agentKvBlobIds
          .map((id) => sqlString(`${CURSOR_AGENTKV_BLOB_PREFIX}${id}`))
          .join(",")})`,
      );
      const rowsByKey = new Map(rows.map((row) => [valueToString(row.key), row]));
      appendAgentKvBlobMessages(
        messages,
        agentKvBlobIds
          .map((id) => rowsByKey.get(`${CURSOR_AGENTKV_BLOB_PREFIX}${id}`))
          .filter((row): row is { key: unknown; value: unknown } => Boolean(row)),
      );
    } catch {
      // Older or session-scoped store.db files may not have cursorDiskKV.
    }
  }

  return buildCursorStoreResult(sessionId, workspacePath, metaJson, messages);
}

function buildCursorStoreResult(
  sessionId: string,
  workspacePath: string,
  metaJson: ChatMeta,
  messages: CursorMessage[],
): ProviderParseResult {
  const { turns, turnStats, totalDurationMs } = messagesToTurns(messages);
  const slug = sessionId.slice(0, 8);
  const title = metaJson.name || firstUserTextSnippet(turns);
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
    cwd: workspacePath,
    model:
      normalizeCursorModelName(metaJson.lastUsedModel) ||
      turnStats.find((stat) => typeof stat.model === "string" && stat.model)?.model,
    startTime: toIsoTimestamp(metaJson.createdAt),
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
  const cleaned = sanitizeCursorUserText(raw);
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
  const hasResult = Object.prototype.hasOwnProperty.call(toolFormerData, "result");

  return {
    type: "tool_use",
    id:
      (typeof toolFormerData.toolCallId === "string" && toolFormerData.toolCallId) ||
      `cursor-bubble-${bubbleId}`,
    name: mapCursorToolName(name),
    input: mapToolArgs(name, paramsRaw, result),
    _hasResult: hasResult,
    ...(hasResult ? { _result: result } : {}),
    ...(hasToolError(toolFormerData.result) ? { _isError: true } : {}),
  };
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
      bubbleTimestamp(entry.bubble) || entry.turnTimestamp || new Date().toISOString();

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
        // Workspace-relative context paths are always POSIX-style; never use the
        // OS-specific separator here (it would emit `src\\utils.ts` on Windows).
        addUniqueContextFile(files, seen, posix.join(directory, name));
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

async function loadAgentKvBlobMessages(
  globalStateDb: CachedGlobalStateDb,
  agentKvBlobIds: string[],
): Promise<CursorMessage[]> {
  const messages: CursorMessage[] = [];
  const rows = await queryCursorDiskKvRowsByKeys(
    globalStateDb,
    agentKvBlobIds.map((id) => `${CURSOR_AGENTKV_BLOB_PREFIX}${id}`),
  );
  const rowsByKey = new Map(rows.map((row) => [valueToString(row.key), row]));
  appendAgentKvBlobMessages(
    messages,
    agentKvBlobIds
      .map((id) => rowsByKey.get(`${CURSOR_AGENTKV_BLOB_PREFIX}${id}`))
      .filter((row): row is { key: unknown; value: unknown } => Boolean(row)),
  );
  return messages;
}

function buildBubbleProjectHintData(entries: GlobalStateBubbleEntry[]): string {
  return entries
    .map((entry) => {
      const bubble = entry.bubble;
      const toolFormerData =
        bubble.toolFormerData && typeof bubble.toolFormerData === "object"
          ? (bubble.toolFormerData as Record<string, any>)
          : undefined;
      return JSON.stringify({
        relevantFiles: bubble.relevantFiles,
        recentlyViewedFiles: bubble.recentlyViewedFiles,
        toolParams: toolFormerData?.params,
      });
    })
    .join("\n");
}

function attachStructuredCursorSubagents(
  turns: ParsedTurn[],
  parentComposerId: string,
  headers: Map<string, CursorComposerHeader>,
): number {
  const childByToolCallId = new Map<string, CursorComposerHeader>();
  for (const header of headers.values()) {
    const info = header.subagentInfo;
    if (info?.parentComposerId === parentComposerId && info.toolCallId) {
      childByToolCallId.set(info.toolCallId, header);
    }
  }
  let attached = 0;
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool_use" || block.name !== "Agent" || block._subAgent) continue;
      const child = childByToolCallId.get(block.id);
      if (!child) continue;
      const prompt =
        typeof block.input.prompt === "string"
          ? block.input.prompt
          : typeof block.input.task === "string"
            ? block.input.task
            : typeof block.input.description === "string"
              ? block.input.description
              : "";
      const description =
        typeof block.input.description === "string" ? block.input.description : undefined;
      const agentType =
        typeof block.input.subagent_type === "string"
          ? block.input.subagent_type
          : typeof block.input.type === "string"
            ? block.input.type
            : "subagent";
      block._subAgent = {
        agentId: child.composerId,
        parentComposerId,
        toolCallId: block.id,
        agentType,
        description,
        prompt,
        toolCalls: 0,
        thinkingBlocks: 0,
        textResponses: 0,
        scenes: [],
      };
      attached++;
    }
  }
  return attached;
}

async function loadCursorRequestContexts(
  globalStateDb: CachedGlobalStateDb,
  sessionId: string,
): Promise<Record<string, any>[]> {
  const rows = await queryGlobalStateRows(
    globalStateDb,
    `SELECT value FROM cursorDiskKV WHERE ${sqlKeyPrefixRange(
      `messageRequestContext:${sessionId}:`,
    )} LIMIT ${MAX_CURSOR_REQUEST_CONTEXT_ROWS}`,
  );

  const contexts: Record<string, any>[] = [];
  for (const row of rows) {
    const raw = valueToString(row.value);
    const parsed = parseJson<Record<string, any>>(raw);
    if (parsed) contexts.push(parsed);
  }
  return contexts;
}

async function countCursorCheckpointEntries(
  globalStateDb: CachedGlobalStateDb,
  sessionId: string,
): Promise<number> {
  const rows = await queryGlobalStateRows(
    globalStateDb,
    `SELECT COUNT(*) AS count FROM cursorDiskKV WHERE ${sqlKeyPrefixRange(
      `checkpointId:${sessionId}:`,
    )}`,
  );
  return toNonNegativeInt(rows[0]?.count);
}

async function loadProjectedBubbleRowsByKeys(
  globalStateDb: CachedGlobalStateDb,
  keys: string[],
): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < keys.length; i += GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + GLOBAL_STATE_BUBBLE_KEY_CHUNK_SIZE);
    rows.push(
      ...(await queryGlobalStateRows(
        globalStateDb,
        `SELECT ${projectedCursorBubbleSelectSql()} FROM cursorDiskKV WHERE key IN (${chunk
          .map(sqlString)
          .join(",")}) AND json_valid(value)`,
      )),
    );
  }
  return rows;
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
  const enrichmentSubagents = new Map(
    enrichment.turns.flatMap((turn) =>
      turn.blocks
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use" && !!block._subAgent,
        )
        .map((block) => [block.id, block._subAgent] as const),
    ),
  );
  const mergedTurns =
    enrichmentSubagents.size === 0
      ? primary.turns
      : primary.turns.map((turn) => ({
          ...turn,
          blocks: turn.blocks.map((block) => {
            if (block.type !== "tool_use" || block._subAgent) return block;
            const subAgent = enrichmentSubagents.get(block.id);
            return subAgent ? { ...block, _subAgent: subAgent } : block;
          }),
        }));
  const mergedSubagents = mergedTurns !== primary.turns;
  const mergedModel = chooseMergedCursorModel(primary.model, enrichment.model);
  const preferEnrichmentDuration =
    enrichment.dataSource === "global-state" &&
    (enrichment.totalDurationMs !== undefined ||
      enrichment.turnStats?.some((stat) => stat.durationMs !== undefined) === true);
  const mergedTurnStats = mergeTurnStats(primary.turnStats, enrichment.turnStats, {
    preferEnrichmentDuration,
  });
  const mergedCompactions = mergeCursorCompactions(primary.compactions, enrichment.compactions);
  const mergedTokenUsage = primary.tokenUsage || enrichment.tokenUsage;
  const mergedTokenUsageByModel = primary.tokenUsageByModel || enrichment.tokenUsageByModel;
  const mergedTotalDurationMs =
    (preferEnrichmentDuration ? enrichment.totalDurationMs : undefined) ||
    primary.totalDurationMs ||
    (!preferEnrichmentDuration ? enrichment.totalDurationMs : undefined) ||
    (mergedTurnStats && mergedTurnStats.length > 0
      ? mergedTurnStats.reduce((sum, stat) => sum + (stat.durationMs || 0), 0) || undefined
      : undefined);
  const mergedDuration = mergedTotalDurationMs !== primary.totalDurationMs;
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
    mergedSubagents ||
    JSON.stringify(mergedCompactions || undefined) !==
      JSON.stringify(primary.compactions || undefined) ||
    (!!mergedTurnStats &&
      JSON.stringify(mergedTurnStats) !== JSON.stringify(primary.turnStats || undefined));
  const primaryNotes = (primary.dataSourceInfo?.notes || []).filter(
    (note) =>
      !(mergedTokens && /token usage is unavailable/i.test(note)) &&
      !(
        mergedDuration &&
        /per-turn duration metrics are unavailable|per-turn duration is estimated from cursor tool execution metadata|duration is estimated from cursor thinking and tool execution timing/i.test(
          note,
        )
      ),
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
    turns: mergedTurns,
    cwd: primary.cwd || enrichment.cwd,
    ...(mergedModel ? { model: mergedModel } : {}),
    ...(mergedTotalDurationMs !== undefined ? { totalDurationMs: mergedTotalDurationMs } : {}),
    ...(mergedTokenUsage ? { tokenUsage: mergedTokenUsage } : {}),
    ...(mergedTokenUsageByModel ? { tokenUsageByModel: mergedTokenUsageByModel } : {}),
    ...(mergedTurnStats ? { turnStats: mergedTurnStats } : {}),
    ...(mergedCompactions ? { compactions: mergedCompactions } : {}),
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

function mergeCursorCompactions(
  primary: Compaction[] | undefined,
  enrichment: Compaction[] | undefined,
): Compaction[] | undefined {
  const merged: Compaction[] = [];
  for (const compaction of [...(primary || []), ...(enrichment || [])]) {
    const timestampMs = Date.parse(compaction.timestamp);
    const existing = merged.find((candidate) => {
      const candidateMs = Date.parse(candidate.timestamp);
      return Number.isFinite(timestampMs) && Number.isFinite(candidateMs)
        ? Math.abs(timestampMs - candidateMs) <= 2_000
        : candidate.timestamp === compaction.timestamp;
    });
    if (!existing) {
      merged.push(compaction);
      continue;
    }
    if (compactionAccuracy(compaction) > compactionAccuracy(existing)) {
      Object.assign(existing, compaction);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function compactionAccuracy(compaction: Compaction): number {
  if (compaction.accuracy === "exact") return 3;
  if (compaction.accuracy === "estimated") return 2;
  if (compaction.accuracy === "lower-bound") return 1;
  return 0;
}

function mergeCursorSidecars(
  primary: CursorSidecars | undefined,
  enrichment: CursorSidecars | undefined,
): CursorSidecars | undefined {
  if (!primary && !enrichment) return undefined;

  const merged: CursorSidecars = {};
  if (primary?.requestContextCount ?? enrichment?.requestContextCount) {
    merged.requestContextCount = primary?.requestContextCount ?? enrichment?.requestContextCount;
  }
  if (primary?.checkpointCount ?? enrichment?.checkpointCount) {
    merged.checkpointCount = primary?.checkpointCount ?? enrichment?.checkpointCount;
  }
  if ((primary?.hasWorkspaceRules ?? enrichment?.hasWorkspaceRules) !== undefined) {
    merged.hasWorkspaceRules = primary?.hasWorkspaceRules ?? enrichment?.hasWorkspaceRules;
  }
  if (
    primary?.conversationCheckpointLastUpdatedAt ||
    enrichment?.conversationCheckpointLastUpdatedAt
  ) {
    merged.conversationCheckpointLastUpdatedAt =
      primary?.conversationCheckpointLastUpdatedAt ??
      enrichment?.conversationCheckpointLastUpdatedAt;
  }
  if (
    primary?.restrictAgentModeSwitching !== undefined ||
    enrichment?.restrictAgentModeSwitching !== undefined
  ) {
    merged.restrictAgentModeSwitching =
      primary?.restrictAgentModeSwitching ?? enrichment?.restrictAgentModeSwitching;
  }
  if (primary?.glassMetaParentAgent || enrichment?.glassMetaParentAgent) {
    merged.glassMetaParentAgent = primary?.glassMetaParentAgent ?? enrichment?.glassMetaParentAgent;
  }

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
  options?: { preferEnrichmentDuration?: boolean },
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
      ...(options?.preferEnrichmentDuration && extra.durationMs !== undefined
        ? { durationMs: extra.durationMs }
        : current.durationMs !== undefined
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
  const toolMs = extractToolExecutionTimeMs(bubble.toolFormerData?.result);
  if (thinkingMs !== undefined && toolMs !== undefined) return thinkingMs + toolMs;
  return thinkingMs ?? toolMs;
}

function timestampValueToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric)
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1000
      : undefined;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

function bubbleTimingInfo(bubble: Record<string, any>): Record<string, any> | undefined {
  return bubble.timingInfo && typeof bubble.timingInfo === "object"
    ? (bubble.timingInfo as Record<string, any>)
    : undefined;
}

function bubbleWallClockStartMs(bubble: Record<string, any>): number | undefined {
  const timingInfo = bubbleTimingInfo(bubble);
  if (!timingInfo) return undefined;
  return (
    timestampValueToMs(timingInfo.clientStartTime) ||
    timestampValueToMs(timingInfo.clientEndTime) ||
    timestampValueToMs(timingInfo.clientSettleTime)
  );
}

function bubbleWallClockEndMs(bubble: Record<string, any>): number | undefined {
  const timingInfo = bubbleTimingInfo(bubble);
  if (!timingInfo) return undefined;
  return (
    timestampValueToMs(timingInfo.clientEndTime) ||
    timestampValueToMs(timingInfo.clientSettleTime) ||
    timestampValueToMs(timingInfo.clientStartTime)
  );
}

function applyGlobalStateWallClockDurations(
  entries: GlobalStateTurnEntry[],
  turnStats: TurnStat[],
): { turnStats: TurnStat[]; totalDurationMs?: number; usedWallClock: boolean } {
  if (entries.length === 0 || turnStats.length === 0) {
    return { turnStats, usedWallClock: false };
  }

  const intervals = buildTurnDurationIntervals(
    entries.map((entry) => ({
      role: entry.turn.role,
      startMs: entry.turn.role === "user" ? bubbleWallClockStartMs(entry.bubble) : undefined,
      endMs: entry.turn.role === "assistant" ? bubbleWallClockEndMs(entry.bubble) : undefined,
    })),
  );
  const durationsByTurn = new Map(
    intervals.flatMap((interval, turnIndex) =>
      interval ? [[turnIndex, interval.endMs - interval.startMs] as const] : [],
    ),
  );

  if (durationsByTurn.size === 0) {
    return {
      turnStats,
      totalDurationMs:
        turnStats.reduce((sum, stat) => sum + (stat.durationMs || 0), 0) || undefined,
      usedWallClock: false,
    };
  }

  const mergedTurnStats = turnStats.map((stat) => {
    const wallClockDuration = durationsByTurn.get(stat.turnIndex);
    return wallClockDuration !== undefined ? { ...stat, durationMs: wallClockDuration } : stat;
  });
  const fallbackDurationMs = turnStats.reduce(
    (sum, stat) => sum + (durationsByTurn.has(stat.turnIndex) ? 0 : stat.durationMs || 0),
    0,
  );
  const wallClockDurationMs = sumDurationIntervals(intervals);
  const totalDurationMs = (wallClockDurationMs || 0) + fallbackDurationMs || undefined;

  return {
    turnStats: mergedTurnStats,
    totalDurationMs,
    usedWallClock: true,
  };
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
  usedWallClock?: boolean;
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

  const {
    turnStats: durationTurnStats,
    totalDurationMs,
    usedWallClock,
  } = applyGlobalStateWallClockDurations(entries, turnStats);

  const totalTokens =
    sessionTokenUsage && hasAnyTokens(sessionTokenUsage) ? sessionTokenUsage : totals;

  return {
    ...(hasAnyTokens(totalTokens) ? { tokenUsage: totalTokens } : {}),
    ...(Object.keys(byModel).length > 0 ? { tokenUsageByModel: byModel } : {}),
    ...(durationTurnStats.length > 0 ? { turnStats: durationTurnStats } : {}),
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
    ...(totalDurationMs !== undefined ? { usedWallClock } : {}),
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
    timestamp: bubbleTimestamp(bubble),
    blocks,
  };
}

async function parseCursorGlobalStateDb(
  sessionId: string,
  globalStateDb?: CachedGlobalStateDb,
  preferredWorkspacePath = "",
): Promise<ProviderParseResult | null> {
  const resolvedGlobalStateDb = globalStateDb ?? (await openGlobalStateDb());
  if (!resolvedGlobalStateDb) return null;

  try {
    const rawComposer = await queryGlobalStateTextValue(
      resolvedGlobalStateDb,
      `composerData:${sessionId}`,
    );
    if (!rawComposer) return null;
    const composer = parseJson<Record<string, any>>(rawComposer);
    if (!composer) return null;

    const entries: GlobalStateTurnEntry[] = [];
    const bubbleEntries: GlobalStateBubbleEntry[] = [];
    const agentKvBlobIds = extractAgentKvBlobIds(rawComposer);

    const addBubble = (bubble: Record<string, any>) => {
      bubbleEntries.push({
        bubble,
        turnTimestamp: bubbleTimestamp(bubble),
      });
      const turn = bubbleToTurn(bubble);
      if (turn) entries.push({ turn, bubble });
    };

    const hasFullConversationHeaders =
      Array.isArray(composer.fullConversationHeadersOnly) &&
      composer.fullConversationHeadersOnly.length > 0;
    if (hasFullConversationHeaders) {
      const bubbleIds: string[] = composerHeaderBubbleIds(composer);
      const expectedBubbleKeys = new Set(
        bubbleIds.map((bubbleId) => `bubbleId:${sessionId}:${bubbleId}`),
      );
      const bubblesByKey = new Map<string, Record<string, any>>();
      // The composer header list is the authoritative conversation order, so
      // only fetch referenced bubble rows instead of every stale key for the session.
      const rows = await loadProjectedBubbleRowsByKeys(resolvedGlobalStateDb, [
        ...expectedBubbleKeys,
      ]);
      for (const row of rows) {
        const key = valueToString(row.key);
        if (!expectedBubbleKeys.has(key)) continue;
        const bubble = projectedCursorBubbleRowToBubble(row);
        if (bubble) bubblesByKey.set(key, bubble);
      }
      for (const bubbleId of bubbleIds) {
        const bubble = bubblesByKey.get(`bubbleId:${sessionId}:${bubbleId}`);
        if (bubble) addBubble(bubble);
      }
    } else if (Array.isArray(composer.conversation)) {
      for (const item of composer.conversation) {
        if (item && typeof item === "object") addBubble(item as Record<string, any>);
      }
    }

    if (agentKvBlobIds.length > 0) {
      const { turns: agentKvTurns } = messagesToTurns(
        await loadAgentKvBlobMessages(resolvedGlobalStateDb, agentKvBlobIds),
      );
      for (const turn of agentKvTurns) {
        const bubble = {
          type: turn.role === "user" ? 1 : 2,
          text: turn.blocks
            .filter(
              (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
            )
            .map((block) => block.text)
            .join("\n"),
        };
        entries.push({ turn, bubble });
      }
    }

    const turns = entries.map((entry) => entry.turn);
    if (turns.length === 0) return null;
    const summaryText = cursorLatestSummaryText(composer);
    const structuredSubagentCount = attachStructuredCursorSubagents(
      turns,
      sessionId,
      await loadComposerHeaders(resolvedGlobalStateDb),
    );

    const inferredProject =
      preferredWorkspacePath ||
      (await inferProjectFromComposerData(
        `${rawComposer}\n${buildBubbleProjectHintData(bubbleEntries)}`,
        [],
      ));
    const modelName = normalizeCursorModelName(
      composer.modelConfig &&
        typeof composer.modelConfig === "object" &&
        typeof composer.modelConfig.modelName === "string"
        ? composer.modelConfig.modelName
        : undefined,
    );
    const requestContexts = await loadCursorRequestContexts(resolvedGlobalStateDb, sessionId);

    const turnTimestamps = turns.map((turn) => turn.timestamp).filter(Boolean);
    const startTime = minIsoTimestamp([composer.createdAt, ...turnTimestamps]);
    const endTime = maxIsoTimestamp([
      composer.lastUpdatedAt,
      composer.conversationCheckpointLastUpdatedAt,
      ...turnTimestamps,
    ]);
    const compactions = cursorCompactions(composer, endTime);
    const replayTurns = summaryText
      ? [
          {
            role: "user" as const,
            subtype: "compaction-summary" as const,
            timestamp: compactions?.[0]?.timestamp,
            blocks: [{ type: "text" as const, text: summaryText }],
          },
          ...turns,
        ]
      : turns;
    const sessionTokenUsage = tokenUsageFromCursorTokenCount(composer.tokenCount);
    const metrics = buildGlobalStateMetrics(entries, modelName, sessionTokenUsage);
    const branchMeta = extractCursorBranchMetadata(composer);
    const prLinks = extractCursorPrLinks(bubbleEntries);
    const apiErrors = extractCursorApiErrors(bubbleEntries);
    const contextSummary = extractCursorContextSummary(bubbleEntries, requestContexts);
    const checkpointCount = await countCursorCheckpointEntries(resolvedGlobalStateDb, sessionId);

    const notes = ["cursorDiskKV keys: composerData:* + bubbleId:*"];
    if (structuredSubagentCount > 0) {
      notes.push(
        `Linked ${structuredSubagentCount} Cursor subagent composer${structuredSubagentCount === 1 ? "" : "s"} to exact Agent tool calls.`,
      );
    }
    if (!metrics.tokenUsage) {
      notes.push("Token usage is unavailable in this Cursor global-state session.");
    } else if (metrics.tokenUsageByModel?.unknown) {
      notes.push("Model attribution is partial; some token usage is grouped under 'unknown'.");
      notes.push("Token usage is estimated from Cursor token snapshots and may be approximate.");
    } else {
      notes.push("Token usage is estimated from Cursor token snapshots.");
    }
    if (compactions) {
      notes.push(
        "Cursor persisted a conversation summary; compaction count is a lower bound because older summaries may be overwritten.",
      );
    }
    if (metrics.totalDurationMs !== undefined) {
      notes.push(
        metrics.usedWallClock
          ? "Per-turn duration is inferred from Cursor bubble timestamps (user prompt to final assistant bubble)."
          : "Duration is estimated from Cursor thinking and tool execution timing.",
      );
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
    const composerSidecarMetadata = cursorComposerSidecarMetadata(composer);
    if (composerSidecarMetadata?.conversationCheckpointLastUpdatedAt) {
      notes.push("Cursor composerData reports a conversation checkpoint timestamp.");
    }
    if (composerSidecarMetadata?.restrictAgentModeSwitching !== undefined) {
      notes.push("Cursor composerData reports agent mode switching restrictions.");
    }
    if (composerSidecarMetadata?.glassMetaParentAgent) {
      notes.push("Cursor composerData links this session to a Glass parent agent.");
    }
    const cursorSidecars =
      contextSummary.requestContextCount ||
      checkpointCount > 0 ||
      contextSummary.hasCursorRules ||
      composerSidecarMetadata
        ? {
            ...(contextSummary.requestContextCount
              ? { requestContextCount: contextSummary.requestContextCount }
              : {}),
            ...(checkpointCount > 0 ? { checkpointCount } : {}),
            ...(contextSummary.hasCursorRules ? { hasWorkspaceRules: true } : {}),
            ...composerSidecarMetadata,
          }
        : undefined;

    return {
      sessionId,
      slug: sessionId.slice(0, 8),
      title:
        (typeof composer.name === "string" && composer.name.trim()) || firstUserTextSnippet(turns),
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
      ...(compactions ? { compactions } : {}),
      ...(branchMeta.gitBranch ? { gitBranch: branchMeta.gitBranch } : {}),
      ...(branchMeta.gitBranches ? { gitBranches: branchMeta.gitBranches } : {}),
      ...(prLinks.length > 0 ? { prLinks } : {}),
      ...(apiErrors ? { apiErrors } : {}),
      ...(contextSummary.contextFiles ? { contextFiles: contextSummary.contextFiles } : {}),
      ...(cursorSidecars ? { cursorSidecars } : {}),
      turns: replayTurns,
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
    const cleaned = sanitizeCursorUserText(content);
    if (isSystemContextText(cleaned)) return [];
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text) {
      if (isSystemContextText(b.text)) continue;
      const cleaned = sanitizeCursorUserText(b.text);
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
        _hasResult: result !== undefined,
        ...(result !== undefined ? { _result: result.result } : {}),
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

    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue;
      const ms = toPositiveMs(block._durationMs);
      if (ms !== undefined) {
        current.durationMs = (current.durationMs || 0) + ms;
      }
    }
  }

  return turnStats;
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
  applyGlobalStateWallClockDurations,
  bubbleTimestamp,
  buildGlobalStateMetrics,
  buildStoreTurnStats,
  createRetryableInit,
  estimateTokenIncrement,
  agentKvBlobMessageToCursorMessage,
  appendAgentKvBlobMessages,
  attachStructuredCursorSubagents,
  extractAgentKvBlobIds,
  extractCursorApiErrors,
  loadAgentKvBlobMessages,
  cursorComposerSidecarMetadata,
  composerHeaderBubbleIds,
  cursorCompactionCount,
  cursorCompactions,
  extractCursorBranchMetadata,
  extractCursorContextSummary,
  extractCursorPrLinks,
  isReplayableGlobalStateBubble,
  hasReplayableRootBlob,
  mapCursorToolName,
  mapToolArgs,
  maxIsoTimestamp,
  minIsoTimestamp,
  mergeCursorParseResults,
  messagesToTurns,
  mergeTurnStats,
  parseAssistantContent,
  parseComposerHeaders,
  inferProjectFromComposerData,
  inferProjectFromComposerDataFast,
  inferProjectRootFromPathHint,
  normalizeTurnText,
  normalizeCursorModelName,
  nextStringPrefix,
  bubbleToTurn,
  parseThinking,
  parseUserContent,
  projectedCursorBubbleRowToBubble,
  projectedCursorBubbleSelectSql,
  cursorLiveDiagnosticsSignature,
  globalStateDbCandidates,
  sqlKeyPrefixRange,
};
