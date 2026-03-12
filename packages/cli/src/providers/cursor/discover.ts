import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "../../types.js";
import {
  discoverGlobalStateOnlySessions,
  discoverSqliteOnlySessions,
  storeDbExists,
} from "./sqlite-reader.js";

const CURSOR_DIR = join(homedir(), ".cursor", "projects");

export async function discoverCursorSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(CURSOR_DIR);
  } catch {
    return sessions;
  }

  for (const projDir of projectDirs) {
    const transcriptsDir = join(CURSOR_DIR, projDir, "agent-transcripts");
    const dirStat = await stat(transcriptsDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const project = await decodeProjectDir(projDir);
    const transcriptEntries = await collectTranscriptEntries(transcriptsDir);
    if (transcriptEntries.length === 0) continue;
    transcriptEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const toolEntries = await collectToolEntries(join(CURSOR_DIR, projDir, "agent-tools"));
    toolEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (let i = 0; i < transcriptEntries.length; i++) {
      const transcript = transcriptEntries[i];
      const prevMtimeMs = i === 0 ? Number.NEGATIVE_INFINITY : transcriptEntries[i - 1].mtimeMs;
      const toolPaths = toolEntries
        .filter((t) => t.mtimeMs > prevMtimeMs && t.mtimeMs <= transcript.mtimeMs)
        .map((t) => t.path);

      const info = await extractSessionInfo(
        transcript.path,
        transcript.fileSize,
        transcript.mtimeMs,
        project,
        toolPaths,
      );
      if (!info) continue;

      info.workspacePath = project;
      info.hasSqlite = false;
      sessions.push(info);
    }
  }

  // Discover SQLite-only sessions (devcontainer, SSH-remote, etc.)
  const transcriptSessions = sessions.slice();
  const knownIds = new Set(transcriptSessions.map((s) => s.sessionId));
  const decodedPaths = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const sqliteOnly = await discoverSqliteOnlySessions(knownIds, decodedPaths);
  sessions.push(...sqliteOnly);
  for (const s of sqliteOnly) knownIds.add(s.sessionId);

  // Discover sessions kept in Cursor global state DB (composerData/bubbleId).
  const globalState = await discoverGlobalStateOnlySessions(knownIds, decodedPaths);
  sessions.push(...globalState.sessions);

  // Mark transcript-discovered sessions that have any SQLite-backed rich data.
  for (const session of transcriptSessions) {
    const hasStoreDb = await storeDbExists(session.workspacePath || "", session.sessionId);
    session.hasSqlite = hasStoreDb || globalState.sessionIds.has(session.sessionId);
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/**
 * Cursor encodes workspace paths by replacing `/` with `-`.
 * But directory names can also contain `-` (e.g. `vibe-replay`),
 * so we resolve ambiguity by checking which paths actually exist on disk.
 */
async function decodeProjectDir(encoded: string): Promise<string> {
  const parts = encoded.split("-");

  async function resolve(idx: number, current: string): Promise<string | null> {
    if (idx >= parts.length) {
      const s = await stat(current).catch(() => null);
      return s?.isDirectory() ? current : null;
    }
    // Try `/` (path separator) first — more common
    const withSlash = `${current}/${parts[idx]}`;
    const slashResult = await resolve(idx + 1, withSlash);
    if (slashResult) return slashResult;
    // Try `-` (literal hyphen in directory name)
    const withHyphen = `${current}-${parts[idx]}`;
    return resolve(idx + 1, withHyphen);
  }

  const result = await resolve(1, `/${parts[0]}`);
  return result || `/${encoded.replace(/-/g, "/")}`;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

async function extractSessionInfo(
  filePath: string,
  fileSize: number,
  mtimeMs: number,
  project: string,
  toolPaths: string[],
): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return null; // too short to be useful

    const sessionId = basename(filePath, ".jsonl");
    let firstPrompt = "";

    // Find first user prompt
    for (const line of lines.slice(0, 10)) {
      try {
        const obj = JSON.parse(line);
        if (obj.role === "user") {
          const textBlock = obj.message?.content?.find?.((b: any) => b.type === "text");
          if (textBlock?.text) {
            // Strip <user_query> wrapper if present
            firstPrompt = textBlock.text
              .replace(/<\/?user_query>/g, "")
              .trim()
              .slice(0, 200);
            break;
          }
        }
      } catch {}
    }

    if (!firstPrompt) return null;

    // Use file mtime as timestamp (Cursor doesn't store timestamps in JSONL)
    const timestamp = new Date(mtimeMs).toISOString();

    return {
      provider: "cursor",
      sessionId,
      slug: sessionId.slice(0, 8),
      project: shortenPath(project),
      cwd: project,
      version: "",
      timestamp,
      lineCount: lines.length,
      fileSize,
      filePath,
      filePaths: [filePath],
      toolPaths,
      firstPrompt,
    };
  } catch {
    return null;
  }
}

interface TranscriptEntry {
  path: string;
  fileSize: number;
  mtimeMs: number;
}

interface ToolEntry {
  path: string;
  mtimeMs: number;
}

async function collectTranscriptEntries(transcriptsDir: string): Promise<TranscriptEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(transcriptsDir);
  } catch {
    return [];
  }

  const transcripts: TranscriptEntry[] = [];
  for (const entry of entries) {
    const entryPath = join(transcriptsDir, entry);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat) continue;

    if (entry.endsWith(".jsonl") && entryStat.isFile()) {
      transcripts.push({
        path: entryPath,
        fileSize: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
      });
      continue;
    }

    if (!entryStat.isDirectory()) continue;

    // Nested transcript form: agent-transcripts/<id>/<id>.jsonl
    const innerPath = join(entryPath, `${entry}.jsonl`);
    const innerStat = await stat(innerPath).catch(() => null);
    if (!innerStat?.isFile()) continue;
    transcripts.push({
      path: innerPath,
      fileSize: innerStat.size,
      mtimeMs: innerStat.mtimeMs,
    });
  }
  return transcripts;
}

async function collectToolEntries(toolDir: string): Promise<ToolEntry[]> {
  const dirStat = await stat(toolDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];

  let entries: string[];
  try {
    entries = await readdir(toolDir);
  } catch {
    return [];
  }

  const tools: ToolEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    const entryPath = join(toolDir, entry);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat?.isFile()) continue;
    tools.push({ path: entryPath, mtimeMs: entryStat.mtimeMs });
  }
  return tools;
}
