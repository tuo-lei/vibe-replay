import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractSessionInfo } from "../claude-code/discover.js";
import type { SessionInfo } from "../../types.js";
import { readGitRepo } from "../../utils.js";

const DESKTOP_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code-sessions",
);

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
  // Claude Desktop stores sessions in ~/Library/Application Support (macOS-only path)
  if (process.platform !== "darwin") return [];
  return discoverFromDir(DESKTOP_DIR, DEFAULT_CLAUDE_PROJECTS_DIR);
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

    // Encoding is identical to Claude Code's own project-dir scheme: replace every "/"
    // with "-". This is inherently lossy for paths containing literal hyphens (e.g.
    // "/Users/me/my-project" and "/Users/me/my/project" both encode to the same string),
    // but it is the scheme Claude Code itself uses so we must match it exactly.
    const encodedCwd = desktop.cwd.replace(/\/+$/, "").replace(/\//g, "-");
    const jsonlPath = join(claudeProjectsDir, encodedCwd, `${desktop.cliSessionId}.jsonl`);

    const jsonlStat = await stat(jsonlPath).catch(() => null);
    if (!jsonlStat) return null;

    const info = await extractSessionInfo(jsonlPath, jsonlStat.size, desktop.cwd);
    if (!info) return null;

    const gitRepo = info.gitRepo || (await readGitRepo(desktop.cwd));

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
