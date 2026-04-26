import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText } from "../../clean-prompt.js";
import type { SessionInfo } from "../../types.js";
import { shortenPath } from "../../utils.js";
import { USER_MESSAGE_BEGIN } from "./constants.js";

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

export async function discoverCodexSessions(): Promise<SessionInfo[]> {
  const byId = new Map<string, SessionInfo>();
  const codexHome = getCodexHome();

  for (const row of await readThreadRowsFromStateDb()) {
    const info = await sessionInfoFromThreadRow(row);
    if (info) byId.set(info.sessionId, info);
  }

  for (const filePath of await findRolloutFiles(join(codexHome, "sessions"))) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const info = await extractCodexSessionInfo(filePath, fileStat.size);
    if (info && !byId.has(info.sessionId)) byId.set(info.sessionId, info);
  }

  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function sessionInfoFromThreadRow(row: CodexThreadRow): Promise<SessionInfo | null> {
  if (!row.id || !row.rollout_path) return null;
  const fileStat = await stat(row.rollout_path).catch(() => null);
  if (!fileStat?.isFile()) return null;

  const extracted = await extractCodexSessionInfo(row.rollout_path, fileStat.size);
  const firstPrompt = cleanCodexUserMessage(row.first_user_message || extracted?.firstPrompt || "");
  if (!firstPrompt) return extracted;

  return {
    provider: "codex",
    sessionId: row.id,
    slug: row.id.slice(0, 8),
    title: row.title || extracted?.title,
    project: shortenPath(row.cwd || extracted?.cwd || ""),
    cwd: row.cwd || extracted?.cwd || "",
    version: row.cli_version || extracted?.version || "",
    gitBranch: row.git_branch || extracted?.gitBranch,
    timestamp:
      toIsoFlexible(row.updated_at_ms || row.updated_at) ||
      extracted?.timestamp ||
      fileStat.mtime.toISOString(),
    lineCount: extracted?.lineCount || 0,
    fileSize: fileStat.size,
    filePath: row.rollout_path,
    filePaths: [row.rollout_path],
    firstPrompt,
    prompts: extracted?.prompts?.length ? extracted.prompts : [firstPrompt],
    promptCount: extracted?.promptCount,
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
          const cleaned = typeof p.message === "string" ? cleanCodexUserMessage(p.message) : "";
          const hasImages = hasUserImages(p);
          if (cleaned.length >= 10 || hasImages) {
            promptCount++;
            if (prompts.length < 2) {
              prompts.push((cleaned || "[Image]").slice(0, 200));
            }
          }
        }
        if (p.type === "exec_command_end" && typeof p.duration?.secs === "number") {
          durationMsEst += p.duration.secs * 1000 + Math.round((p.duration.nanos || 0) / 1_000_000);
        }
        continue;
      }

      if (obj.type === "response_item") {
        const p = obj.payload || {};
        if (p.type === "function_call") {
          toolCallCount++;
          if (isEditTool(p.name)) editCountEst++;
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
  }

  if (!sessionId) {
    const m = basename(filePath).match(/rollout-.+-(.+)\.jsonl$/);
    sessionId = m?.[1] || "";
  }
  if (!sessionId || prompts.length === 0) return null;

  return {
    provider: "codex",
    sessionId,
    slug: sessionId.slice(0, 8),
    title,
    project: shortenPath(cwd),
    cwd,
    version,
    gitBranch,
    timestamp: timestamp || (await stat(filePath).then((s) => s.mtime.toISOString())),
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0],
    prompts,
    promptCount,
    toolCallCount,
    model,
    durationMsEst: durationMsEst || undefined,
    editCountEst: editCountEst || undefined,
  };
}

async function readThreadRowsFromStateDb(): Promise<CodexThreadRow[]> {
  const stateDbPath = getStateDbPath();
  const dbStat = await stat(stateDbPath).catch(() => null);
  if (!dbStat?.isFile() || dbStat.size < 1024) return [];

  try {
    const mod = await import("sql.js");
    const SQL = await mod.default();
    const dbBuffer = await import("node:fs/promises").then((fs) => fs.readFile(stateDbPath));
    const db = new SQL.Database(dbBuffer);
    try {
      const result = db.exec(`
        SELECT id, rollout_path, created_at, updated_at, source, cwd, title,
               tokens_used, git_branch, cli_version, first_user_message, model, reasoning_effort,
               created_at_ms, updated_at_ms
        FROM threads
        WHERE archived = 0
        ORDER BY updated_at_ms DESC, updated_at DESC
      `);
      const table = result[0];
      if (!table) return [];
      return table.values.map((values: any[]) => {
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
      else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
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

function getStateDbPath(): string {
  const sqliteHome = process.env.CODEX_SQLITE_HOME || getCodexHome();
  return join(sqliteHome, STATE_DB_FILENAME);
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

function cleanCodexUserMessage(text: string): string {
  const withoutPrefix = text.includes(USER_MESSAGE_BEGIN)
    ? text.slice(text.indexOf(USER_MESSAGE_BEGIN) + USER_MESSAGE_BEGIN.length)
    : text;
  return cleanPromptText(withoutPrefix);
}

function hasUserImages(payload: any): boolean {
  return (
    (Array.isArray(payload.images) && payload.images.length > 0) ||
    (Array.isArray(payload.local_images) && payload.local_images.length > 0)
  );
}
