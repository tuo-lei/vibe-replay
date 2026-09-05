import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo } from "@vibe-replay/provider-core/utils";
import { getGrokBotTranscriptRoots } from "./config.js";
import { mergeDiscoveredGroupSessions } from "./group-merge.js";
import { countGrokBotDiscoveryStats } from "./parser.js";
import { readAgentGroup, readAgentProfile } from "./profiles.js";

export { readAgentGroup, readAgentProfile } from "./profiles.js";
export type { AgentGroup, AgentProfile } from "./profiles.js";

export async function discoverGrokBotSessions(
  roots = getGrokBotTranscriptRoots(),
  resolveGitRepo = true,
  includeUnreplayable = false,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const seenFiles = new Set<string>();

  for (const root of await uniqueExistingDirs(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const sessionDir = join(root, entry);
      const dirStat = await stat(sessionDir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const filePath = join(sessionDir, `${entry}.jsonl`);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      const resolved = await realpath(filePath).catch(() => filePath);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);

      const info = await extractGrokBotSessionInfo(
        filePath,
        fileStat.size,
        fileStat.mtime.toISOString(),
        root,
        resolveGitRepo,
        includeUnreplayable,
      );
      if (info) sessions.push(info);
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return mergeDiscoveredGroupSessions(sessions);
}

async function extractGrokBotSessionInfo(
  filePath: string,
  fileSize: number,
  fileMtime: string,
  transcriptsRoot: string,
  resolveGitRepo: boolean,
  includeUnreplayable: boolean,
): Promise<SessionInfo | null> {
  const sessionId = basename(filePath, ".jsonl");
  if (!sessionId) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    if (!includeUnreplayable) return null;
    return unreadableSession(sessionId, filePath, fileSize, fileMtime);
  }

  const lines = content.split("\n");
  const lineCount = lines.filter((line) => line.trim()).length;
  let sawParseableRecord = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      JSON.parse(line);
      sawParseableRecord = true;
      break;
    } catch {
      // keep looking
    }
  }

  const unreadable = !sawParseableRecord;
  const stats = countGrokBotDiscoveryStats(content);
  const prompts = stats.prompts
    .map((prompt) => cleanPromptText(prompt))
    .filter(Boolean)
    .slice(0, 2);

  if (!includeUnreplayable && (unreadable || prompts.length === 0)) return null;

  const profile = await readAgentProfile(transcriptsRoot, sessionId);
  const group = await readAgentGroup(transcriptsRoot, sessionId, profile);
  const groupTitle = stats.groupTitle || group?.title || profile?.groupTitle;
  const cwd = profile?.cwd || profile?.name || groupTitle || sessionId;
  const gitRepo = resolveGitRepo && looksLikePath(cwd) ? await readGitRepo(cwd) : profile?.gitRepo;
  const title = groupTitle
    ? `Group: ${groupTitle}`
    : profile?.name || (sessionId.startsWith("sand-subagent-") ? "Grok Bot subagent" : undefined);
  const project = groupTitle || cwd;

  return {
    provider: "grok-bot",
    sessionId,
    slug: sessionId,
    title,
    project,
    cwd,
    version: "1",
    ...(profile?.gitBranch ? { gitBranch: profile.gitBranch } : {}),
    ...(gitRepo ? { gitRepo } : {}),
    timestamp: stats.timestamp || fileMtime,
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0] || "",
    prompts: prompts.length > 0 ? prompts : undefined,
    promptCount: unreadable ? 0 : stats.promptCount,
    toolCallCount: stats.toolCallCount,
    editCountEst: stats.editCountEst,
    ...(profile?.model ? { model: profile.model } : {}),
    ...(unreadable || prompts.length === 0
      ? { transcriptStatus: unreadable ? ("unreadable" as const) : ("no-prompts" as const) }
      : {}),
  };
}

function unreadableSession(
  sessionId: string,
  filePath: string,
  fileSize: number,
  fileMtime: string,
): SessionInfo {
  return {
    provider: "grok-bot",
    sessionId,
    slug: sessionId,
    project: sessionId,
    cwd: sessionId,
    version: "1",
    timestamp: fileMtime,
    lineCount: 0,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: "",
    promptCount: 0,
    transcriptStatus: "unreadable",
  };
}

async function uniqueExistingDirs(roots: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    const dirStat = await stat(root).catch(() => null);
    if (!dirStat?.isDirectory()) continue;
    const resolved = await realpath(root).catch(() => root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push(root);
  }
  return unique;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
