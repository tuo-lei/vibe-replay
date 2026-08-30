import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo, shortenPath } from "@vibe-replay/provider-core/utils";
import { classifyProject, isCursorSdkAutomationPath } from "@vibe-replay/types";
import {
  discoverGlobalStateOnlySessions,
  discoverSqliteOnlySessions,
  getCursorSessionFingerprints,
  listStoreDbSessionIds,
} from "./sqlite-reader.js";
import { discoverSdkAgents, type SdkAgent } from "./sdk-reader.js";
import { sanitizeCursorUserText } from "./sanitize.js";

const CURSOR_DIR = join(homedir(), ".cursor", "projects");
const PROJECT_DISCOVERY_CONCURRENCY = 6;
const TRANSCRIPT_INFO_CONCURRENCY = 6;
const ENTRY_STAT_CONCURRENCY = 32;
const decodedProjectDirCache = new Map<string, Promise<string>>();
const sdkWorkspaceRepoCache = new Map<string, Promise<string | undefined>>();
let cursorDiscoveryInFlight: Promise<SessionInfo[]> | null = null;

/** Coalesce dashboard/source scans that request the same local catalog concurrently. */
export function discoverCursorSessions(): Promise<SessionInfo[]> {
  if (cursorDiscoveryInFlight) return cursorDiscoveryInFlight;
  const current = discoverCursorSessionsOnce();
  const tracked = current.finally(() => {
    if (cursorDiscoveryInFlight === tracked) cursorDiscoveryInFlight = null;
  });
  cursorDiscoveryInFlight = tracked;
  return tracked;
}

async function discoverCursorSessionsOnce(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  // SDK databases are independent from IDE transcript/store discovery. Start
  // their machine-wide index in parallel instead of paying both costs serially.
  const sdkAgentsPromise = discoverSdkAgents().catch(() => [] as SdkAgent[]);

  let projectDirs: string[];
  try {
    projectDirs = await readdir(CURSOR_DIR);
  } catch {
    projectDirs = [];
  }

  const projectSessions = await mapLimit(projectDirs, PROJECT_DISCOVERY_CONCURRENCY, (projDir) =>
    discoverProjectSessions(projDir),
  );
  for (const projectSessionList of projectSessions) {
    sessions.push(...projectSessionList);
  }
  const mergedTranscriptSessions = mergeDuplicateTranscriptSessions(sessions);
  sessions.length = 0;
  sessions.push(...mergedTranscriptSessions);

  // Discover SQLite-only sessions (devcontainer, SSH-remote, etc.)
  const transcriptSessions = sessions.slice();
  const knownIds = new Set(transcriptSessions.map((s) => s.sessionId));
  const decodedPaths = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const sqliteOnly = await discoverSqliteOnlySessions(knownIds, decodedPaths, true);
  sessions.push(...sqliteOnly);
  for (const s of sqliteOnly) knownIds.add(s.sessionId);

  // Discover sessions kept in Cursor global state DB (composerData/bubbleId).
  const globalState = await discoverGlobalStateOnlySessions(knownIds, decodedPaths);
  sessions.push(...globalState.sessions);
  const globalStateById = new Map(
    globalState.allSessions.map((session) => [session.sessionId, session]),
  );

  // Mark transcript-discovered sessions that have any SQLite-backed rich data.
  const storeDbSessionIds = await listStoreDbSessionIds();
  for (const session of transcriptSessions) {
    const hasStoreDb = storeDbSessionIds.has(session.sessionId);
    session.hasSqlite = hasStoreDb || globalState.sessionIds.has(session.sessionId);
    const globalStateSession = globalStateById.get(session.sessionId);
    if (globalStateSession?.compactionCount) {
      session.compactionCount = Math.max(
        session.compactionCount || 0,
        globalStateSession.compactionCount,
      );
    }
  }

  // Cursor SDK sessions live alongside Cursor IDE chats but in their own SQLite
  // store. Mark transcripts that also have an SDK record so the parser can enrich
  // them with structured tool results, run timing, and per-turn model.
  await enrichWithSdkAgents(sessions, await sdkAgentsPromise);
  const fingerprints = await getCursorSessionFingerprints(
    sessions.map((session) => session.sessionId),
  );
  for (const session of sessions) {
    const fingerprint = fingerprints.get(session.sessionId);
    if (fingerprint) session.sourceFingerprint = fingerprint;
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/**
 * The same Cursor transcript can be copied between encoded project directories.
 * Keep one catalog entry per session ID while passing every unique path to the
 * parser, which performs record-level deduplication for overlapping files.
 */
function mergeDuplicateTranscriptSessions(sessions: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const group = byId.get(session.sessionId) || [];
    group.push(session);
    byId.set(session.sessionId, group);
  }

  const merged: SessionInfo[] = [];
  for (const group of byId.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const ranked = group.toSorted(
      (a, b) =>
        (b.lineCount || 0) - (a.lineCount || 0) ||
        (b.fileSize || 0) - (a.fileSize || 0) ||
        b.timestamp.localeCompare(a.timestamp),
    );
    const primary = ranked[0];
    const filePaths = [...new Set(group.flatMap((session) => session.filePaths))];
    const toolPaths = [...new Set(group.flatMap((session) => session.toolPaths || []))];
    merged.push({
      ...primary,
      filePaths,
      filePath: primary.filePath,
      fileSize: Math.max(...group.map((session) => session.fileSize || 0)),
      ...(toolPaths.length > 0 ? { toolPaths } : {}),
    });
  }
  return merged;
}

async function discoverProjectSessions(projDir: string): Promise<SessionInfo[]> {
  const transcriptsDir = join(CURSOR_DIR, projDir, "agent-transcripts");
  const dirStat = await stat(transcriptsDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];

  const project = await decodeProjectDir(projDir);
  const gitRepo = await readGitRepo(project);
  const transcriptEntries = await collectTranscriptEntries(transcriptsDir);
  if (transcriptEntries.length === 0) return [];
  transcriptEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toolEntries = await collectToolEntries(join(CURSOR_DIR, projDir, "agent-tools"));
  toolEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const jobs: Array<TranscriptEntry & { toolPaths: string[] }> = [];
  let toolStart = 0;
  let toolEnd = 0;
  for (let i = 0; i < transcriptEntries.length; i++) {
    const transcript = transcriptEntries[i];
    const prevMtimeMs = i === 0 ? Number.NEGATIVE_INFINITY : transcriptEntries[i - 1].mtimeMs;
    while (toolStart < toolEntries.length && toolEntries[toolStart].mtimeMs <= prevMtimeMs) {
      toolStart++;
    }
    while (toolEnd < toolEntries.length && toolEntries[toolEnd].mtimeMs <= transcript.mtimeMs) {
      toolEnd++;
    }
    jobs.push({
      ...transcript,
      toolPaths: toolEntries.slice(toolStart, toolEnd).map((tool) => tool.path),
    });
  }

  const infos = await mapLimit(jobs, TRANSCRIPT_INFO_CONCURRENCY, async (job) => {
    const info = await extractSessionInfo(
      job.path,
      job.fileSize,
      job.mtimeMs,
      project,
      job.toolPaths,
    );
    if (!info) return null;
    info.workspacePath = project;
    info.hasSqlite = false;
    info.gitRepo = gitRepo;
    return info;
  });

  return infos.filter((info): info is SessionInfo => info !== null);
}

async function enrichWithSdkAgents(sessions: SessionInfo[], sdkAgents: SdkAgent[]): Promise<void> {
  if (sdkAgents.length === 0) return;

  const sessionsByAgentId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    sessionsByAgentId.set(session.sessionId, session);
  }

  for (const agent of sdkAgents) {
    const existing = sessionsByAgentId.get(agent.agentId);
    if (!existing) continue;
    existing.hasSdk = true;
    const workspaceRef = agent.workspaceRef.trim();

    // The SDK's workspace_ref is authoritative when it points at one of its
    // actual worktrees. Cursor's encoded project directory can turn literal
    // underscores into hyphens, so the decoded transcript path may not exist
    // even though the SDK path does.
    if (workspaceRef && isCursorSdkAutomationPath(workspaceRef)) {
      const workspaceStat = await stat(workspaceRef).catch(() => null);
      if (workspaceStat?.isDirectory()) {
        existing.project = shortenPath(workspaceRef);
        existing.cwd = workspaceRef;
        existing.workspacePath = workspaceRef;
        const gitRepo = await readSdkWorkspaceRepo(workspaceRef);
        if (gitRepo) existing.gitRepo = gitRepo;
      }
    }

    existing.projectIdentity = classifyProject(shortenPath(existing.project), {
      provider: existing.provider,
      hasSdk: true,
      sdkAgentId: agent.agentId,
      sdkAgentName: agent.name,
      sdkWorkspaceRef: workspaceRef,
      gitRepo: existing.gitRepo,
    });
  }
}

function readSdkWorkspaceRepo(workspacePath: string): Promise<string | undefined> {
  let cached = sdkWorkspaceRepoCache.get(workspacePath);
  if (!cached) {
    cached = readGitRepo(workspacePath);
    sdkWorkspaceRepoCache.set(workspacePath, cached);
  }
  return cached;
}

/**
 * Cursor encodes workspace paths by replacing `/` with `-`.
 * But directory names can also contain `-` (e.g. `vibe-replay`),
 * so we resolve ambiguity by checking which paths actually exist on disk.
 */
async function decodeProjectDir(encoded: string): Promise<string> {
  let cached = decodedProjectDirCache.get(encoded);
  if (!cached) {
    // Cursor project dirs are stable for the lifetime of the CLI/server process;
    // cache the resolved path so repeated discovery doesn't re-walk the same tree.
    cached = decodeProjectDirUncached(encoded).catch((err) => {
      decodedProjectDirCache.delete(encoded);
      throw err;
    });
    decodedProjectDirCache.set(encoded, cached);
  }
  return cached;
}

async function decodeProjectDirUncached(encoded: string): Promise<string> {
  if (process.platform === "win32") return decodeWindowsProjectDir(encoded);
  const parts = encoded.split("-");
  const startIdx = parts[0] ? 0 : 1;
  const resolved = await resolveEncodedProjectParts(parts, startIdx, "/");
  if (resolved) return joinUnresolvedRemainder(resolved, parts, "/");
  const fallbackEncoded = encoded.startsWith("-") ? encoded.slice(1) : encoded;
  return `/${fallbackEncoded.replace(/-/g, "/")}`;
}

/**
 * Append whatever the filesystem walk could not confirm. Once a real parent
 * directory is found, a missing child is far more likely to be one deleted
 * directory whose name contains `-` than several nested ones, so the remainder
 * stays in one piece. Splitting it would shred run ids — a deleted
 * `.../artifacts/slack-inbox-<uuid>` scratch dir turned into five path
 * segments and a project named after the tail of its UUID.
 */
function joinUnresolvedRemainder(
  resolved: PartialResolution,
  parts: string[],
  separator: string,
): string {
  if (resolved.nextIdx >= parts.length) return resolved.path;
  const remainder = parts.slice(resolved.nextIdx).join("-");
  return resolved.path.endsWith(separator)
    ? `${resolved.path}${remainder}`
    : `${resolved.path}${separator}${remainder}`;
}

/**
 * Windows variant of {@link decodeProjectDir}. Cursor encodes `C:\a\b` as
 * `C-a-b`, dropping the drive colon and turning every separator into `-`.
 * The first segment is the drive letter; the rest are resolved against the
 * real filesystem so directory names that legitimately contain `-`
 * (e.g. `vibe-replay`) are not split apart.
 */
async function decodeWindowsProjectDir(encoded: string): Promise<string> {
  const parts = encoded.split("-").filter((part, idx) => part !== "" || idx !== 0);
  if (parts.length === 0) return encoded;

  const drive = parts[0];
  // Bail out for non-path project dirs (e.g. `empty-window`, numeric ids):
  // a real Windows drive is a single ASCII letter.
  if (!/^[a-zA-Z]$/.test(drive)) {
    return parts.join("\\");
  }

  const root = `${drive.toUpperCase()}:\\`;
  const resolved = await resolveEncodedProjectParts(parts, 1, root);
  if (resolved) return joinUnresolvedRemainder(resolved, parts, "\\");
  return parts.length === 1 ? root : `${root}${parts.slice(1).join("\\")}`;
}

/** How far into the encoded segments the filesystem walk got. */
interface PartialResolution {
  path: string;
  /** Index of the first segment that could not be matched on disk. */
  nextIdx: number;
}

/**
 * Walk the encoded segments against the real filesystem, returning the deepest
 * directory that exists. A partial result matters because these workspaces are
 * often deleted after the fact: the parent still pins down where the slashes
 * go, which is all the caller needs to stop guessing at the missing tail.
 */
async function resolveEncodedProjectParts(
  parts: string[],
  idx: number,
  current: string,
): Promise<PartialResolution | null> {
  if (idx >= parts.length) {
    const currentStat = await stat(current).catch(() => null);
    return currentStat?.isDirectory() ? { path: current, nextIdx: idx } : null;
  }

  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return null;

  const dirNames = new Set(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name),
  );

  let deepest: PartialResolution | null = null;

  // Try slash boundaries first to preserve the old behavior, but only explore
  // names that are real child directories instead of stat-ing every split.
  for (let end = idx + 1; end <= parts.length; end++) {
    const candidate = parts.slice(idx, end).join("-");
    // Cursor drops the leading dot when it encodes a path, so `/Users/me/.cursor`
    // becomes `Users-me-cursor`. Without this the walk stops at every dotfile
    // directory and everything below it gets guessed instead of read.
    const actual = dirNames.has(candidate)
      ? candidate
      : dirNames.has(`.${candidate}`)
        ? `.${candidate}`
        : null;
    const candidatePath = join(current, actual ?? candidate);
    if (!actual) {
      // Windows temp/profile paths can contain 8.3 short-name segments such as
      // RUNNER~1. They are valid paths but do not appear in readdir(), so use a
      // targeted stat fallback before giving up on this split.
      if (process.platform !== "win32") continue;
      const candidateStat = await stat(candidatePath).catch(() => null);
      if (!candidateStat?.isDirectory()) continue;
    }
    const resolved = await resolveEncodedProjectParts(parts, end, candidatePath);
    if (resolved?.nextIdx === parts.length) return resolved;
    const best = resolved ?? { path: candidatePath, nextIdx: end };
    if (!deepest || best.nextIdx > deepest.nextIdx) deepest = best;
  }

  return deepest;
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

    const sessionId = basename(filePath, ".jsonl");
    let firstPrompt = "";

    // Count user prompts and tool calls — data already in memory, zero extra I/O
    // Only count user messages that are actual prompts, not tool_result messages.
    // NOTE: The `!line.includes('"tool_result"')` heuristic could theoretically under-count
    // if a user's actual prompt text literally contains the string "tool_result". This is an
    // accepted edge case — it's extremely rare in practice and the fast string check avoids
    // JSON-parsing every line.
    let promptCount = 0;
    let toolCallCount = 0;
    let editCountEst = 0;
    let model: string | undefined;
    let lineCount = 0;
    let userPromptCandidateCount = 0;
    const toolUseRe = /"type"\s*:\s*"tool_use"/g;
    const editToolRe = /"name"\s*:\s*"(edit_file|file_edit|create_file)"/;
    const modelRe = /"model(?:Id)?"\s*:\s*"([^"]+)"/;
    const userRoleRe = /"role"\s*:\s*"user"/;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      lineCount++;

      // Cursor may prepend many metadata/assistant records before the first
      // user turn. Bound the expensive JSON parsing by user candidates rather
      // than raw lines, otherwise eleven harmless records make a valid
      // session disappear from discovery.
      if (
        !firstPrompt &&
        userPromptCandidateCount < 10 &&
        userRoleRe.test(line) &&
        !line.includes('"tool_result"')
      ) {
        userPromptCandidateCount++;
        try {
          const obj = JSON.parse(line);
          if (obj.role === "user") {
            const textBlock = obj.message?.content?.find?.((b: any) => b.type === "text");
            if (textBlock?.text) {
              firstPrompt = sanitizeCursorUserText(textBlock.text).slice(0, 200);
            }
          }
        } catch {}
      }

      if (
        (line.includes('"role":"user"') || line.includes('"role": "user"')) &&
        !line.includes('"tool_result"')
      ) {
        promptCount++;
      }
      const toolMatches = line.match(toolUseRe);
      if (toolMatches) {
        toolCallCount += toolMatches.length;
        if (editToolRe.test(line)) editCountEst++;
      }
      // Extract model from first assistant message
      if (!model && line.includes('"assistant"') && line.includes('"model')) {
        const m = line.match(modelRe);
        if (m) model = m[1];
      }
    }
    if (lineCount < 2) return null; // too short to be useful
    if (!firstPrompt) return null;

    // Cursor transcript markers can be missing in some flows; tool artifacts are
    // a better lower bound for real tool activity in the same time window.
    toolCallCount = Math.max(toolCallCount, toolPaths.length);

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
      lineCount,
      fileSize,
      filePath,
      filePaths: [filePath],
      toolPaths,
      firstPrompt,
      promptCount,
      toolCallCount,
      model,
      editCountEst: editCountEst || undefined,
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

  const transcripts = await mapLimit(entries, ENTRY_STAT_CONCURRENCY, async (entry) => {
    const entryPath = join(transcriptsDir, entry);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat) return null;

    if (entry.endsWith(".jsonl") && entryStat.isFile()) {
      return {
        path: entryPath,
        fileSize: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
      };
    }

    if (!entryStat.isDirectory()) return null;

    // Nested transcript form: agent-transcripts/<id>/<id>.jsonl
    const innerPath = join(entryPath, `${entry}.jsonl`);
    const innerStat = await stat(innerPath).catch(() => null);
    if (!innerStat?.isFile()) return null;
    return {
      path: innerPath,
      fileSize: innerStat.size,
      mtimeMs: innerStat.mtimeMs,
    };
  });
  return transcripts.filter((entry): entry is TranscriptEntry => entry !== null);
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

  const toolFiles = entries.filter((entry) => entry.endsWith(".txt"));
  const tools = await mapLimit(toolFiles, ENTRY_STAT_CONCURRENCY, async (entry) => {
    const entryPath = join(toolDir, entry);
    const entryStat = await stat(entryPath).catch(() => null);
    if (!entryStat?.isFile()) return null;
    return { path: entryPath, mtimeMs: entryStat.mtimeMs };
  });
  return tools.filter((entry): entry is ToolEntry => entry !== null);
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

export const __testables = {
  decodeProjectDir,
  extractSessionInfo,
  mergeDuplicateTranscriptSessions,
};
