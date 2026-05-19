import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ParsedTurn } from "../../types.js";
import { mapCursorToolName, mapToolArgs } from "./sqlite-reader.js";

/**
 * Cursor SDK local agent state lives at:
 *   ~/.cursor/projects/<workspace-slug>/sdk-agent-store/<projectHash>/index.db
 *
 * Schema (as of Cursor SDK schemaVersion 1):
 *   agents      — agent_id, workspace_ref, status, name, latest_checkpoint_ref_json, ...
 *   runs        — run_id, agent_id, turn_number, status, model, started_at, finished_at, result
 *   run_events  — run_id, seq, event_type='run_stream_event', payload_json (sdk_message envelope)
 *
 * Per-agent blob/checkpoint store lives at:
 *   ~/.cursor/projects/<workspace-slug>/sdk-agent-store/<projectHash>/agents/<sha256(agentId)>/store.db
 * but we don't need the blobs to enrich a replay — runs + run_events have everything we render.
 *
 * The Cursor IDE also writes a human-readable JSONL transcript at:
 *   ~/.cursor/projects/<workspace-slug>/agent-transcripts/<agentId>/<agentId>.jsonl
 * which the existing Cursor provider already discovers. The SDK store is what gives us
 * the missing tool *results*, structured per-run timing, and per-run model names.
 */

const CURSOR_PROJECTS_ROOT = join(homedir(), ".cursor", "projects");
const SDK_STORE_SUBDIR = "sdk-agent-store";
const SDK_INDEX_DB_BASENAME = "index.db";
const MIN_INDEX_DB_SIZE = 1024;
const MAX_SQLJS_DB_BYTES = 128 * 1024 * 1024;

const execFileAsync = promisify(execFile);

const getSqlJs = (() => {
  let promise: Promise<any> | null = null;
  return async () => {
    if (!promise) {
      promise = (async () => {
        const mod = await import("sql.js");
        return mod.default();
      })().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
})();

export interface SdkAgent {
  agentId: string;
  workspaceRef: string;
  status: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  /** Absolute path to the SDK index.db file backing this agent. */
  dbPath: string;
}

export interface SdkRun {
  runId: string;
  agentId: string;
  turnNumber: number;
  status: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Final assistant text (if recorded by the SDK). */
  result?: string;
}

export interface SdkToolCall {
  callId: string;
  runId: string;
  /** Sequence number of the *first* event for this call (the "running" one). */
  firstSeq: number;
  /** Sequence number of the terminal event (completed/error). */
  lastSeq: number;
  name: string;
  args: Record<string, any>;
  status: string;
  /** Stringified result body — already shaped for downstream tool-arg inference. */
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface SdkAgentEnrichment {
  agent: SdkAgent;
  runs: SdkRun[];
  /** Tool calls keyed by runId, in event order (first observation wins). */
  toolCallsByRun: Map<string, SdkToolCall[]>;
  /** Earliest started_at across runs. */
  startedAt?: string;
  /** Latest finished_at across runs. */
  finishedAt?: string;
  /** Sum of per-run durations (ms). */
  totalDurationMs?: number;
  /** Most-recent model seen across runs. */
  latestModel?: string;
}

interface IndexDbHandle {
  dbPath: string;
  backend: "sqlite-cli" | "sqljs";
  /** sql.js Database instance — only present when backend === "sqljs". */
  db?: any;
}

let cachedAgentIndex: Map<string, SdkAgent> | null = null;
let cachedAgentIndexAt = 0;
const AGENT_INDEX_TTL_MS = 5_000;

/**
 * Best-effort discovery of every SDK agent on this machine. Safe to call repeatedly —
 * results are cached for a short window so live mode doesn't pay full SQLite cost.
 */
export async function discoverSdkAgents(): Promise<SdkAgent[]> {
  const index = await getSdkAgentIndex();
  return [...index.values()];
}

export async function findSdkAgentById(agentId: string): Promise<SdkAgent | null> {
  if (!agentId) return null;
  const index = await getSdkAgentIndex();
  return index.get(agentId) || null;
}

/** Force-clear the SDK agent index cache. Useful for tests and live mode. */
export function invalidateSdkAgentIndexCache(): void {
  cachedAgentIndex = null;
  cachedAgentIndexAt = 0;
}

async function getSdkAgentIndex(): Promise<Map<string, SdkAgent>> {
  if (cachedAgentIndex && Date.now() - cachedAgentIndexAt < AGENT_INDEX_TTL_MS) {
    return cachedAgentIndex;
  }
  const dbPaths = await listSdkIndexDbPaths(CURSOR_PROJECTS_ROOT);
  const index = new Map<string, SdkAgent>();
  for (const dbPath of dbPaths) {
    let handle: IndexDbHandle | null = null;
    try {
      handle = await openIndexDb(dbPath);
      if (!handle) continue;
      const rows = await queryIndexDb(
        handle,
        "SELECT agent_id, workspace_ref, status, name, created_at, updated_at FROM agents",
      );
      for (const row of rows) {
        const agentId = stringOrEmpty(row.agent_id);
        if (!agentId) continue;
        index.set(agentId, {
          agentId,
          workspaceRef: stringOrEmpty(row.workspace_ref),
          status: stringOrEmpty(row.status) || "UNKNOWN",
          name: typeof row.name === "string" ? row.name : undefined,
          createdAt: stringOrEmpty(row.created_at),
          updatedAt: stringOrEmpty(row.updated_at),
          dbPath,
        });
      }
    } catch {
      // SDK schema differs across Cursor versions; skip databases we can't read.
    } finally {
      closeIndexDb(handle);
    }
  }
  cachedAgentIndex = index;
  cachedAgentIndexAt = Date.now();
  return index;
}

/**
 * Read a single agent's runs + stream events and assemble the structured
 * enrichment record used to augment the JSONL transcript.
 */
export async function loadSdkAgentEnrichment(agent: SdkAgent): Promise<SdkAgentEnrichment | null> {
  let handle: IndexDbHandle | null = null;
  try {
    handle = await openIndexDb(agent.dbPath);
    if (!handle) return null;

    const runRows = await queryIndexDb(
      handle,
      [
        "SELECT run_id, agent_id, turn_number, status, model,",
        "started_at, finished_at, result",
        `FROM runs WHERE agent_id = ${sqlString(agent.agentId)}`,
        "ORDER BY turn_number ASC, created_at ASC",
      ].join(" "),
    );
    if (runRows.length === 0) return null;

    const runs: SdkRun[] = runRows.map((row) => ({
      runId: stringOrEmpty(row.run_id),
      agentId: stringOrEmpty(row.agent_id),
      turnNumber: typeof row.turn_number === "number" ? row.turn_number : Number(row.turn_number),
      status: stringOrEmpty(row.status),
      model: row.model ? String(row.model) : undefined,
      startedAt: row.started_at ? String(row.started_at) : undefined,
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      result: row.result ? String(row.result) : undefined,
    }));

    const runIds = runs.map((r) => r.runId).filter(Boolean);
    if (runIds.length === 0) return { agent, runs, toolCallsByRun: new Map() };
    // The dynamic IN list is built from run_id values read from this same local
    // DB. Values are still SQLite-escaped, and the sqlite3 backend uses execFile
    // (no shell), so this stays local-data-only and shell-injection safe.
    const inList = runIds.map(sqlString).join(", ");
    const eventRows = await queryIndexDb(
      handle,
      [
        "SELECT run_id, seq, payload_json FROM run_events",
        `WHERE run_id IN (${inList}) ORDER BY run_id, seq`,
      ].join(" "),
    );

    const toolCallsByRun = collectToolCalls(eventRows);

    return finalizeEnrichment(agent, runs, toolCallsByRun);
  } catch {
    return null;
  } finally {
    closeIndexDb(handle);
  }
}

function finalizeEnrichment(
  agent: SdkAgent,
  runs: SdkRun[],
  toolCallsByRun: Map<string, SdkToolCall[]>,
): SdkAgentEnrichment {
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let totalDurationMs = 0;
  let totalDurationSeen = false;
  let latestModel: string | undefined;

  for (const run of runs) {
    if (run.startedAt && (!startedAt || run.startedAt < startedAt)) startedAt = run.startedAt;
    if (run.finishedAt && (!finishedAt || run.finishedAt > finishedAt)) finishedAt = run.finishedAt;
    if (run.startedAt && run.finishedAt) {
      const startMs = Date.parse(run.startedAt);
      const endMs = Date.parse(run.finishedAt);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        totalDurationMs += endMs - startMs;
        totalDurationSeen = true;
      }
    }
    if (run.model) latestModel = run.model;
  }

  return {
    agent,
    runs,
    toolCallsByRun,
    startedAt,
    finishedAt,
    totalDurationMs: totalDurationSeen ? totalDurationMs : undefined,
    latestModel,
  };
}

interface RunEventRow {
  run_id?: string;
  payload_json?: string;
  seq?: number | string;
}

function collectToolCalls(rows: Record<string, any>[]): Map<string, SdkToolCall[]> {
  const out = new Map<string, SdkToolCall[]>();
  // Track the call we're building per (runId, callId).
  const inProgress = new Map<string, SdkToolCall>();

  for (const rawRow of rows) {
    const row = rawRow as RunEventRow;
    const payload = row.payload_json;
    if (typeof payload !== "string" || !payload) continue;
    const parsed = safeJsonParse(payload);
    const message = parsed?.message;
    if (!message || message.type !== "tool_call") continue;

    const runId = stringOrEmpty(row.run_id);
    const callId = stringOrEmpty(message.call_id);
    if (!runId || !callId) continue;
    const seq = typeof row.seq === "number" ? row.seq : Number(row.seq);
    if (!Number.isFinite(seq)) continue;

    const key = `${runId}::${callId}`;
    const rawName = typeof message.name === "string" ? message.name : "Tool";
    const mappedName = mapCursorToolName(rawName);
    const argsObj = isPlainObject(message.args) ? message.args : {};
    const status = typeof message.status === "string" ? message.status : "unknown";

    let entry = inProgress.get(key);
    if (!entry) {
      entry = {
        callId,
        runId,
        firstSeq: seq,
        lastSeq: seq,
        name: mappedName,
        args: argsObj,
        status,
      };
      inProgress.set(key, entry);
      const list = out.get(runId) || [];
      list.push(entry);
      out.set(runId, list);
    } else {
      entry.lastSeq = seq;
      entry.status = status;
      // Args sometimes get fleshed out across "running" updates — prefer the
      // latest non-empty payload even when the key count stays the same.
      if (Object.keys(argsObj).length > 0) {
        entry.args = argsObj;
      }
    }

    if (message.result !== undefined) {
      const formatted = formatSdkToolResult(rawName, message.result);
      entry.result = formatted.text;
      entry.isError = formatted.isError || status === "error";
    }
  }

  // Sort calls within each run by their first appearance.
  for (const [runId, list] of out) {
    list.sort((a, b) => a.firstSeq - b.firstSeq);
    out.set(runId, list);
  }
  return out;
}

interface FormattedToolResult {
  text: string;
  isError: boolean;
}

/**
 * The SDK records tool results as structured `{ status, value }` objects. Downstream
 * Cursor parsing expects a string — but for Edit-family tools the existing inference
 * helpers parse a JSON shape with `diff.chunks[].diffString`. We reshape so they hit.
 */
export function formatSdkToolResult(rawToolName: string, result: unknown): FormattedToolResult {
  if (result === null || result === undefined) return { text: "", isError: false };
  if (typeof result === "string") return { text: result, isError: false };
  if (!isPlainObject(result)) {
    return { text: safeJsonStringify(result), isError: false };
  }

  const status = typeof result.status === "string" ? result.status : "";
  const isError = status === "error" || status === "failed" || result.error !== undefined;
  const value = result.value !== undefined ? result.value : result;

  const mapped = mapCursorToolName(rawToolName);

  if (isError && typeof result.error === "string") {
    return { text: result.error, isError: true };
  }

  if (mapped === "Bash" && isPlainObject(value)) {
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const stderr = typeof value.stderr === "string" ? value.stderr : "";
    const exitCode = typeof value.exitCode === "number" ? value.exitCode : undefined;
    const parts: string[] = [];
    if (stdout) parts.push(stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    if (parts.length === 0 && typeof exitCode === "number") parts.push(`exit ${exitCode}`);
    return {
      text: parts.join("\n"),
      isError: isError || (exitCode !== undefined && exitCode !== 0),
    };
  }

  if (mapped === "Read" && isPlainObject(value) && typeof value.content === "string") {
    return { text: value.content, isError };
  }

  if ((mapped === "Edit" || mapped === "Write" || mapped === "MultiEdit") && isPlainObject(value)) {
    const diffString = typeof value.diffString === "string" ? value.diffString : "";
    if (diffString) {
      // Wrap in the `diff.chunks[].diffString` shape that inferEditStringsFromResult understands,
      // and keep the raw stats for downstream use.
      const wrapped = {
        ...value,
        diff: { chunks: [{ diffString }] },
      };
      return { text: safeJsonStringify(wrapped), isError };
    }
  }

  return { text: safeJsonStringify(value), isError };
}

/**
 * Apply SDK tool results onto a JSONL-parsed turn list in place. Pairing strategy:
 *   - SDK runs are processed in turn-number order.
 *   - JSONL turns are processed in their existing order, with each user prompt advancing
 *     to the next SDK run.
 *   - Within a run, JSONL `tool_use` blocks (across the assistant turns belonging to that
 *     run, in order) are paired one-to-one with SDK tool_calls in the same run.
 *
 * We never *create* new blocks — we only enrich existing ones. This keeps the user-facing
 * JSONL transcript as the source of truth for what the user saw, and uses the SDK store
 * solely to fill in tool results, durations, and per-turn model.
 */
export function applySdkEnrichmentToTurns(
  turns: ParsedTurn[],
  enrichment: SdkAgentEnrichment,
): { turns: ParsedTurn[]; toolCallsEnriched: number; assistantTurnsModelTagged: number } {
  const sortedRuns = [...enrichment.runs].sort((a, b) => a.turnNumber - b.turnNumber);
  if (sortedRuns.length === 0) {
    return { turns, toolCallsEnriched: 0, assistantTurnsModelTagged: 0 };
  }

  // Walk JSONL turns; each user turn (after the first) advances to the next SDK run.
  // toolUseIdx intentionally spans assistant-turn boundaries within a run: the
  // SDK call stream is flat per run, while JSONL can split one run across
  // multiple assistant messages.
  let runIdx = -1;
  let toolUseIdx = 0;
  let toolCallsEnriched = 0;
  let assistantTurnsModelTagged = 0;

  for (const turn of turns) {
    if (turn.role === "user") {
      runIdx++;
      toolUseIdx = 0;
      continue;
    }
    if (turn.role !== "assistant") continue;
    if (runIdx < 0) {
      // Assistant text appearing before any user prompt — leave alone.
      continue;
    }
    const run = sortedRuns[runIdx];
    if (!run) continue;

    if (run.model && !turn.model) {
      turn.model = run.model;
      assistantTurnsModelTagged++;
    }

    const sdkCalls = enrichment.toolCallsByRun.get(run.runId) || [];
    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue;
      // Only enrich when the JSONL block lacks a result. Empty-string results
      // are valid tool outputs, so any string `_result` counts as already resolved.
      if (typeof block._result === "string") continue;

      const sdkCall = sdkCalls[toolUseIdx];
      toolUseIdx++;
      if (!sdkCall) continue;

      // A running-only SDK event has no result payload. Leave it missing rather
      // than converting "not yet known" into a concrete empty result.
      if (sdkCall.result === undefined) continue;

      block._result = sdkCall.result;
      if (sdkCall.isError) block._isError = true;
      // Re-run the Cursor arg mapper so Edit blocks pick up old/new strings from the
      // result we just attached.
      try {
        block.input = mapToolArgs(block.name, block.input, block._result);
      } catch {
        // mapToolArgs is defensive but never throws in practice; ignore if it does.
      }
      toolCallsEnriched++;
    }
  }

  return { turns, toolCallsEnriched, assistantTurnsModelTagged };
}

// ---------------------------------------------------------------------------
// SQLite plumbing — kept minimal and isolated from the IDE-chat reader.
// ---------------------------------------------------------------------------

async function openIndexDb(dbPath: string): Promise<IndexDbHandle | null> {
  const st = await stat(dbPath).catch(() => null);
  if (!st?.isFile() || st.size < MIN_INDEX_DB_SIZE) return null;

  if (await canUseSqliteCliFor(dbPath)) {
    return { dbPath, backend: "sqlite-cli" };
  }

  let SQL: any;
  try {
    SQL = await getSqlJs();
  } catch {
    return null;
  }
  if (st.size > MAX_SQLJS_DB_BYTES) return null;
  const buffer = await readFile(dbPath).catch(() => null);
  if (!buffer) return null;
  const db = new SQL.Database(buffer);
  return { dbPath, backend: "sqljs", db };
}

function closeIndexDb(handle: IndexDbHandle | null): void {
  if (!handle || handle.backend !== "sqljs" || !handle.db) return;
  try {
    handle.db.close();
  } catch {
    // ignore — we drop the reference either way
  }
}

async function queryIndexDb(handle: IndexDbHandle, sql: string): Promise<Record<string, any>[]> {
  if (handle.backend === "sqlite-cli") {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", handle.dbPath, sql], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Record<string, any>[]) : [];
  }
  const result = handle.db.exec(sql);
  if (!Array.isArray(result) || result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map((row: unknown[]) => {
    const record: Record<string, any> = {};
    columns.forEach((column: string, index: number) => {
      record[column] = row[index];
    });
    return record;
  });
}

const sqliteCliCheckCache = new Map<string, { canUse: boolean; checkedAt: number }>();
const SQLITE_CLI_CHECK_TTL_MS = 30_000;

async function canUseSqliteCliFor(dbPath: string): Promise<boolean> {
  const cached = sqliteCliCheckCache.get(dbPath);
  if (cached && Date.now() - cached.checkedAt < SQLITE_CLI_CHECK_TTL_MS) return cached.canUse;

  let canUse = false;
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", dbPath, "SELECT json_valid('{}') AS ok;"],
      { maxBuffer: 1024 * 1024 },
    );
    const rows = JSON.parse(stdout.trim()) as Array<{ ok?: number }>;
    canUse = rows[0]?.ok === 1;
  } catch {
    canUse = false;
  }
  sqliteCliCheckCache.set(dbPath, { canUse, checkedAt: Date.now() });
  return canUse;
}

async function listSdkIndexDbPaths(projectsRoot: string): Promise<string[]> {
  const projects = await readdir(projectsRoot).catch(() => [] as string[]);
  const perProjectPaths = await Promise.all(
    projects.map(async (project) => {
      const out: string[] = [];
      const sdkRoot = join(projectsRoot, project, SDK_STORE_SUBDIR);
      const sdkStat = await stat(sdkRoot).catch(() => null);
      if (!sdkStat?.isDirectory()) return out;
      const projectHashes = await readdir(sdkRoot).catch(() => [] as string[]);
      for (const hash of projectHashes) {
        const dbPath = join(sdkRoot, hash, SDK_INDEX_DB_BASENAME);
        const dbStat = await stat(dbPath).catch(() => null);
        if (!dbStat?.isFile() || dbStat.size < MIN_INDEX_DB_SIZE) continue;
        out.push(dbPath);
      }
      return out;
    }),
  );
  return perProjectPaths.flat();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const __testables = {
  collectToolCalls,
  finalizeEnrichment,
  listSdkIndexDbPaths,
};
