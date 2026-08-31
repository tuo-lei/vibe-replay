import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractSessionInfo } from "../claude-code/discover.js";
import { claudeDataDirs } from "../claude-data-paths.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo } from "@vibe-replay/provider-core/utils";

export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface DesktopSessionJson {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  originCwd?: string;
  worktreePath?: string;
  worktreeName?: string;
  sourceBranch?: string;
  branch?: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  isArchived?: boolean;
  title?: string;
  permissionMode?: string;
  completedTurns?: number;
  scheduledTaskId?: string;
}

export async function discoverClaudeDesktopSessions(): Promise<SessionInfo[]> {
  const dataDirs = await claudeDataDirs();
  return discoverFromDirs(
    dataDirs.map((dataDir) => join(dataDir, "claude-code-sessions")),
    DEFAULT_CLAUDE_PROJECTS_DIR,
  );
}

export async function discoverFromDirs(
  desktopDirs: string[],
  claudeProjectsDir: string,
): Promise<SessionInfo[]> {
  const sessionsById = new Map<string, SessionInfo>();

  for (const desktopDir of desktopDirs) {
    const sessions = await discoverFromDir(desktopDir, claudeProjectsDir);
    for (const session of sessions) {
      if (!sessionsById.has(session.sessionId)) sessionsById.set(session.sessionId, session);
    }
  }

  return Array.from(sessionsById.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function discoverFromDir(
  desktopDir: string,
  claudeProjectsDir: string,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let accountDirs: string[];
  try {
    accountDirs = await readdir(desktopDir);
  } catch {
    return sessions;
  }

  for (const accountId of accountDirs) {
    const accountPath = join(desktopDir, accountId);
    const accountStat = await stat(accountPath).catch(() => null);
    if (!accountStat?.isDirectory()) continue;

    let orgDirs: string[];
    try {
      orgDirs = await readdir(accountPath);
    } catch {
      continue;
    }

    for (const orgId of orgDirs) {
      const orgPath = join(accountPath, orgId);
      const orgStat = await stat(orgPath).catch(() => null);
      if (!orgStat?.isDirectory()) continue;

      let files: string[];
      try {
        files = await readdir(orgPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.startsWith("local_") || !file.endsWith(".json")) continue;

        const jsonPath = join(orgPath, file);
        const info = await extractDesktopSessionInfo(jsonPath, claudeProjectsDir);
        if (info) sessions.push(info);
      }
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

export async function extractDesktopSessionInfo(
  jsonPath: string,
  claudeProjectsDir: string = DEFAULT_CLAUDE_PROJECTS_DIR,
): Promise<SessionInfo | null> {
  try {
    const content = await readFile(jsonPath, "utf-8");
    const desktop: DesktopSessionJson = JSON.parse(content);

    if (!desktop.cliSessionId || !desktop.cwd) return null;

    // Claude Code encodes Windows drive paths as `C--Users-...` and has also
    // written `C:-Users-...` in older versions. Keep the candidates explicit
    // so a backslash in the metadata never becomes a real path separator.
    const encodedCwds = encodeClaudeProjectDirs(desktop.cwd);
    let jsonlPath = "";
    let jsonlStat: Awaited<ReturnType<typeof stat>> | null = null;

    for (const encodedCwd of encodedCwds) {
      const candidatePath = join(claudeProjectsDir, encodedCwd, `${desktop.cliSessionId}.jsonl`);
      const candidateStat = await stat(candidatePath).catch(() => null);
      if (candidateStat) {
        jsonlPath = candidatePath;
        jsonlStat = candidateStat;
        break;
      }
    }

    if (!jsonlPath || !jsonlStat) return null;

    const info = await extractSessionInfo(jsonlPath, jsonlStat.size, desktop.cwd);
    if (!info) return null;

    const gitRepo = await readGitRepo(desktop.cwd);

    return {
      ...info,
      provider: "claude-desktop",
      title: desktop.title || info.title,
      model: desktop.model || info.model,
      timestamp: new Date(desktop.lastActivityAt).toISOString(),
      gitRepo,
    };
  } catch {
    return null;
  }
}

function encodeClaudeProjectDirs(cwd: string): string[] {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  const candidates = [
    normalized.replace(/[/:]/g, "-"),
    normalized.replace(/\//g, "-"),
    `-${normalized.replace(/\//g, "-")}`,
  ];

  return Array.from(new Set(candidates));
}
