/// <reference path="../sql-js.d.ts" />
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo, shortenPath } from "@vibe-replay/provider-core/utils";
import {
  CODEX_CONTEXT_TAGS,
  codexStripTwoPass,
  contentText,
  isCodexToolCallType,
} from "./constants.js";

const STATE_DB_FILENAME = "state_5.sqlite";

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  source: string;
  cwd: string;
  title: string;
  tokens_used: number;
  git_branch?: string;
  cli_version?: string;
  first_user_message?: string;
  model?: string;
  reasoning_effort?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
}

/** Metadata stored by Codex for the `/resume` list. */
export interface CodexSessionMetadata {
  sessionId: string;
  rolloutPath?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
  title?: string;
  /** Latest explicit name from session_index.jsonl; `/resume` prefers this. */
  threadName?: string;
  gitBranch?: string;
  cliVersion?: string;
  firstUserMessage?: string;
  model?: string;
}

export async function discoverCodexSessions(
  codexHome = getCodexHome(),
  includeStateDb = true,
  resolveGitRepo = true,
): Promise<SessionInfo[]> {
  const byId = new Map<string, SessionInfo>();
  const stateMetadata = new Map<string, CodexSessionMetadata>();

  if (includeStateDb) {
    for (const row of await readThreadRowsFromStateDb(codexHome)) {
      const info = await sessionInfoFromThreadRow(row, resolveGitRepo);
      if (info) byId.set(info.sessionId, info);
      if (row.id) stateMetadata.set(row.id, codexMetadataFromThreadRow(row));
    }
  }
  for (const [sessionId, threadName] of await readCodexSessionIndex(codexHome)) {
    const metadata = stateMetadata.get(sessionId) || { sessionId };
    stateMetadata.set(sessionId, { ...metadata, threadName });
    const existing = byId.get(sessionId);
    if (existing) existing.title = threadName;
  }

  for (const filePath of await findRolloutFiles(join(codexHome, "sessions"))) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const info = await extractCodexSessionInfo(filePath, fileStat.size);
    if (!info) continue;
    const stateInfo = stateMetadata.get(info.sessionId);
    const existing = byId.get(info.sessionId);
    if (!existing || (existing.transcriptStatus && info.transcriptStatus !== "unreadable")) {
      const merged = stateInfo ? mergeCodexSessionMetadata(info, stateInfo) : info;
      if (resolveGitRepo && merged.cwd && !merged.gitRepo) {
        merged.gitRepo = await readGitRepo(merged.cwd);
      }
      byId.set(info.sessionId, merged);
    }
  }

  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Read the append-only rename index; the newest valid record for an id wins. */
export async function readCodexSessionIndex(
  codexHome = getCodexHome(),
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const input = createReadStream(join(codexHome, "session_index.jsonl"), { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const sessionId = typeof record.id === "string" ? record.id.trim() : "";
        const threadName = typeof record.thread_name === "string" ? record.thread_name.trim() : "";
        if (sessionId && threadName) names.set(sessionId, threadName);
      } catch {
        // Keep prior valid rename entries when a trailing append is incomplete.
      }
    }
  } catch {
    return new Map();
  } finally {
    rl.close();
  }
  return names;
}

async function sessionInfoFromThreadRow(
  row: CodexThreadRow,
  resolveGitRepo = true,
): Promise<SessionInfo | null> {
  if (!row.id) return null;
  const fileStat = row.rollout_path ? await stat(row.rollout_path).catch(() => null) : null;
  const extracted = fileStat?.isFile()
    ? await extractCodexSessionInfo(row.rollout_path, fileStat.size)
    : undefined;
  const transcriptStatus = extracted ? extracted.transcriptStatus : "unreadable";
  const rowFirstPrompt = row.first_user_message
    ? normalizeDiscoveredUserMessage(row.first_user_message)
    : "";
  const cwd = row.cwd || extracted?.cwd || "";
  const gitRepo = resolveGitRepo ? await readGitRepo(cwd) : undefined;
  const firstPrompt =
    transcriptStatus === undefined ? rowFirstPrompt || extracted?.firstPrompt || "" : "";
  const prompts =
    transcriptStatus === undefined
      ? firstPrompt
        ? [
            firstPrompt,
            ...(extracted?.prompts || []).filter((prompt) => prompt !== firstPrompt),
          ].slice(0, 2)
        : extracted?.prompts
      : undefined;
  const sourcePath = row.rollout_path || "";

  return {
    provider: "codex",
    sessionId: row.id,
    slug: row.id.slice(0, 8),
    transcriptStatus,
    title: row.title || extracted?.title,
    project: shortenPath(cwd),
    cwd,
    version: row.cli_version || extracted?.version || "",
    gitBranch: row.git_branch || extracted?.gitBranch,
    gitRepo,
    timestamp:
      toIsoFlexible(row.updated_at_ms || row.updated_at) ||
      extracted?.timestamp ||
      fileStat?.mtime.toISOString() ||
      toIsoFlexible(row.created_at_ms || row.created_at) ||
      new Date(0).toISOString(),
    lineCount: extracted?.lineCount || 0,
    fileSize: fileStat?.size || 0,
    filePath: sourcePath,
    filePaths: sourcePath ? [sourcePath] : [],
    firstPrompt,
    prompts,
    promptCount: transcriptStatus === undefined ? extracted?.promptCount : 0,
    toolCallCount: extracted?.toolCallCount,
    model: row.model || extracted?.model,
    durationMsEst: extracted?.durationMsEst,
    editCountEst: extracted?.editCountEst,
    hasPR: extracted?.hasPR,
  };
}

export async function extractCodexSessionInfo(
  filePath: string,
  fileSize: number,
): Promise<SessionInfo | null> {
  let sessionId = "";
  let cwd = "";
  let version = "";
  let timestamp = "";
  let title: string | undefined;
  let model: string | undefined;
  let gitBranch: string | undefined;
  let lineCount = 0;
  let promptCount = 0;
  let toolCallCount = 0;
  let editCountEst = 0;
  let durationMsEst = 0;
  const prompts: string[] = [];
  const promptSeen = new Map<string, number[]>();
  let sawKnownRecord = false;
  let readFailed = false;

  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      lineCount++;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;

      if (
        obj.type === "session_meta" ||
        obj.type === "turn_context" ||
        obj.type === "event_msg" ||
        obj.type === "response_item" ||
        obj.type === "compacted"
      ) {
        sawKnownRecord = true;
      }

      if (obj.timestamp) timestamp = obj.timestamp;

      if (obj.type === "session_meta") {
        const p = obj.payload || {};
        sessionId = sessionId || p.id || "";
        cwd = cwd || p.cwd || "";
        version = version || p.cli_version || "";
        if (p.timestamp && !timestamp) timestamp = p.timestamp;
        gitBranch = gitBranch || p.git?.branch || p.git_branch;
        continue;
      }

      if (obj.type === "turn_context") {
        const p = obj.payload || {};
        model = model || p.model;
        continue;
      }

      if (obj.type === "event_msg") {
        const p = obj.payload || {};
        if (p.type === "thread_name_updated" && p.thread_name) title = p.thread_name;
        if (p.type === "user_message") {
          const rawText = typeof p.message === "string" ? p.message : "";
          const cleaned = normalizeDiscoveredUserMessage(rawText);
          const imageKey = userImageDedupeKey(p);
          if (recordDiscoveredPrompt(promptSeen, prompts, obj.timestamp, cleaned, imageKey)) {
            promptCount++;
          }
        }
        if (p.type === "exec_command_end" && typeof p.duration?.secs === "number") {
          durationMsEst += p.duration.secs * 1000 + Math.round((p.duration.nanos || 0) / 1_000_000);
        }
        continue;
      }

      if (obj.type === "response_item") {
        const p = obj.payload || {};
        if (p.type === "message" && p.role === "user") {
          const rawText = contentText(p.content);
          const cleaned = normalizeDiscoveredUserMessage(rawText);
          const imageKey = contentImageDedupeKey(p.content);
          if (recordDiscoveredPrompt(promptSeen, prompts, obj.timestamp, cleaned, imageKey)) {
            promptCount++;
          }
        }
        if (isCodexToolCallType(p.type)) {
          toolCallCount++;
          if (isEditTool(p.name)) editCountEst++;
        }
      }
    }
  } catch {
    readFailed = true;
  } finally {
    rl?.close();
  }

  if (!sessionId) {
    const fileName = basename(filePath);
    const uuid = fileName.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    );
    const m = fileName.match(/rollout-.+-(.+)\.jsonl$/);
    sessionId = uuid?.[1] || m?.[1] || "";
  }
  if (!sessionId) return null;
  const transcriptStatus =
    readFailed || !sawKnownRecord
      ? ("unreadable" as const)
      : prompts.length === 0
        ? ("no-prompts" as const)
        : undefined;
  const fallbackStat = timestamp ? undefined : await stat(filePath).catch(() => undefined);

  return {
    provider: "codex",
    sessionId,
    slug: sessionId.slice(0, 8),
    transcriptStatus,
    title,
    project: shortenPath(cwd),
    cwd,
    version,
    gitBranch,
    timestamp: timestamp || fallbackStat?.mtime.toISOString() || new Date(0).toISOString(),
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0] || "",
    prompts: prompts.length > 0 ? prompts : undefined,
    promptCount,
    toolCallCount,
    model,
    durationMsEst: durationMsEst || undefined,
    editCountEst: editCountEst || undefined,
  };
}

async function readThreadRowsFromStateDb(codexHome: string): Promise<CodexThreadRow[]> {
  const stateDbPath = getStateDbPath(codexHome);
  const dbStat = await stat(stateDbPath).catch(() => null);
  if (!dbStat?.isFile() || dbStat.size === 0) return [];

  try {
    const mod = await import("sql.js");
    const SQL = await mod.default();
    const dbBuffer = await readFile(stateDbPath);
    const db = new SQL.Database(dbBuffer);
    try {
      const tableInfo = db.exec("PRAGMA table_info(threads)")[0];
      const columns = new Set(
        tableInfo?.values
          .map((values) => values[1])
          .filter((value): value is string => typeof value === "string") || [],
      );
      if (!columns.has("id")) return [];
      const selectedColumns = [
        "id",
        "rollout_path",
        "created_at",
        "updated_at",
        "source",
        "cwd",
        "title",
        "tokens_used",
        "git_branch",
        "cli_version",
        "first_user_message",
        "model",
        "reasoning_effort",
        "created_at_ms",
        "updated_at_ms",
      ];
      const selectList = selectedColumns.map((name) =>
        columns.has(name) ? name : `NULL AS ${name}`,
      );
      const where = columns.has("archived") ? " WHERE archived = 0" : "";
      const orderColumns = ["updated_at_ms", "updated_at"].filter((name) => columns.has(name));
      const order = orderColumns.length
        ? ` ORDER BY ${orderColumns.map((name) => `${name} DESC`).join(", ")}`
        : "";
      const result = db.exec(`
        SELECT ${selectList.join(", ")}
        FROM threads${where}${order}
      `);
      const table = result[0];
      if (!table) return [];
      return table.values.map((values) => {
        const row: Record<string, any> = {};
        table.columns.forEach((col: string, i: number) => {
          row[col] = values[i];
        });
        return row as CodexThreadRow;
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function findRolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = join(current, entry.name);
      if (entry.isDirectory()) await walk(fp);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(fp);
      }
    }
  }
  await walk(dir);
  return out;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function getStateDbPath(codexHome = getCodexHome()): string {
  const sqliteHome = process.env.CODEX_SQLITE_HOME || codexHome;
  return join(sqliteHome, STATE_DB_FILENAME);
}

function codexMetadataFromThreadRow(row: CodexThreadRow): CodexSessionMetadata {
  return {
    sessionId: row.id,
    ...(row.rollout_path ? { rolloutPath: row.rollout_path } : {}),
    ...(row.created_at !== undefined && row.created_at !== null
      ? { createdAt: row.created_at }
      : {}),
    ...(row.updated_at !== undefined && row.updated_at !== null
      ? { updatedAt: row.updated_at }
      : {}),
    ...(row.created_at_ms !== undefined && row.created_at_ms !== null
      ? { createdAtMs: row.created_at_ms }
      : {}),
    ...(row.updated_at_ms !== undefined && row.updated_at_ms !== null
      ? { updatedAtMs: row.updated_at_ms }
      : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
    ...(row.cli_version ? { cliVersion: row.cli_version } : {}),
    ...(row.first_user_message ? { firstUserMessage: row.first_user_message } : {}),
    ...(row.model ? { model: row.model } : {}),
  };
}

function toIsoFlexible(value?: number): string | undefined {
  if (!value) return undefined;
  const millis = value < 1_577_836_800_000 ? value * 1000 : value;
  const d = new Date(millis);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function isEditTool(name?: string): boolean {
  return !!name && ["apply_patch", "edit", "write_file"].includes(name);
}

function normalizeDiscoveredUserMessage(text: string): string {
  return cleanPromptText(codexStripTwoPass(text));
}

/**
 * Merge Codex state metadata into a JSONL-discovered session.
 *
 * Codex keeps the replayable transcript in JSONL but stores the title shown by
 * `/resume` in state_5.sqlite. Remote transports can query that metadata
 * without copying a live database, then use this same merge for parity with
 * local discovery.
 */
export function mergeCodexSessionMetadata(
  session: SessionInfo,
  metadata: CodexSessionMetadata | undefined,
): SessionInfo {
  if (!metadata || metadata.sessionId !== session.sessionId) return session;

  const firstPrompt =
    !session.transcriptStatus && metadata.firstUserMessage
      ? normalizeDiscoveredUserMessage(metadata.firstUserMessage)
      : "";
  const cwd = metadata.cwd?.trim();
  const timestamp =
    metadataTimestamp(metadata.updatedAtMs) ||
    metadataTimestamp(metadata.updatedAt) ||
    session.timestamp;
  const prompts = firstPrompt
    ? [firstPrompt, ...(session.prompts || []).filter((prompt) => prompt !== firstPrompt)].slice(
        0,
        2,
      )
    : session.prompts;
  const resumeTitle = metadata.threadName?.trim() || metadata.title?.trim();

  return {
    ...session,
    ...(resumeTitle ? { title: resumeTitle } : {}),
    ...(cwd ? { cwd, project: shortenPath(cwd) } : {}),
    ...(metadata.cliVersion?.trim() ? { version: metadata.cliVersion.trim() } : {}),
    ...(metadata.gitBranch?.trim() ? { gitBranch: metadata.gitBranch.trim() } : {}),
    ...(metadata.model?.trim() ? { model: metadata.model.trim() } : {}),
    ...(firstPrompt ? { firstPrompt, prompts } : {}),
    timestamp,
  };
}

function metadataTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return toIsoFlexible(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return toIsoFlexible(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function recordDiscoveredPrompt(
  promptSeen: Map<string, number[]>,
  prompts: string[],
  timestamp: string | undefined,
  text: string,
  imageKey: string,
): boolean {
  const hasImages = imageKey.length > 0;
  if (isCodexContextMessage(text)) return false;
  if (!text && !hasImages) return false;
  const key = `${text}:images:${imageKey}`;
  const time = timestamp ? Date.parse(timestamp) : Number.NaN;
  const previous = promptSeen.get(key) || [];
  const isDuplicate = Number.isNaN(time)
    ? previous.length > 0
    : previous.some((prev) => Math.abs(time - prev) <= 2_000);
  if (isDuplicate) return false;
  promptSeen.set(key, [...previous, Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time]);
  if (prompts.length < 2) prompts.push((text || "[Image]").slice(0, 200));
  return true;
}

function isCodexContextMessage(text: string): boolean {
  const trimmed = text.trim();
  return CODEX_CONTEXT_TAGS.some((tag) => trimmed.startsWith(`<${tag}>`));
}

function userImageDedupeKey(payload: any): string {
  return [
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
  ]
    .filter((image): image is string => typeof image === "string" && image.length > 0)
    .map(imageDedupeKey)
    .join(",");
}

function contentImageDedupeKey(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (part?.type !== "input_image" && part?.type !== "image" && part?.type !== "local_image") {
        return [];
      }
      const image =
        typeof part.image_url === "string"
          ? part.image_url
          : typeof part.image_url?.url === "string"
            ? part.image_url.url
            : typeof part.source?.data === "string"
              ? `data:${part.source.media_type || "image/png"};base64,${part.source.data}`
              : typeof part.path === "string"
                ? part.path
                : "";
      return image ? [image] : [];
    })
    .map(imageDedupeKey)
    .join(",");
}

function imageDedupeKey(image: string): string {
  return `${image.slice(0, 64)}:${image.length}:${image.slice(-32)}`;
}
