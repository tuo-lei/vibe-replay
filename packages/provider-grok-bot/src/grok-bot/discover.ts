import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo } from "@vibe-replay/provider-core/utils";
import {
  defaultGrokBotClientPersistenceDir,
  getGrokBotClientPersistenceDir,
  getGrokBotTranscriptRoots,
} from "./config.js";
import { mergeDiscoveredGroupSessions } from "./group-merge.js";
import { countGrokBotDiscoveryStats } from "./parser.js";
import { readAgentGroup, readAgentProfile } from "./profiles.js";
import { agentIdFromReplicaFilename, summarizeReplicaDocument } from "./replica.js";
import { isSandSubagentSessionId } from "./subagent.js";

export { readAgentGroup, readAgentProfile } from "./profiles.js";
export type { AgentGroup, AgentProfile } from "./profiles.js";

export async function discoverGrokBotSessions(
  roots = getGrokBotTranscriptRoots(),
  resolveGitRepo = true,
  includeUnreplayable = false,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const seenFiles = new Set<string>();
  const jsonlByAgent = new Map<string, { filePath: string; fileSize: number; fileMtime: string }>();

  for (const root of await uniqueExistingDirs(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Background workers attach onto the parent `task` card; listing them as
      // their own sessions floods the picker and dashboard.
      if (isSandSubagentSessionId(entry)) continue;
      const sessionDir = join(root, entry);
      const dirStat = await stat(sessionDir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const filePath = join(sessionDir, `${entry}.jsonl`);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      const resolved = await realpath(filePath).catch(() => filePath);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      jsonlByAgent.set(entry, {
        filePath,
        fileSize: fileStat.size,
        fileMtime: fileStat.mtime.toISOString(),
      });

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

  await attachClientReplicas(
    sessions,
    jsonlByAgent,
    roots,
    persistenceRootsFor(roots),
    includeUnreplayable,
  );

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return mergeDiscoveredGroupSessions(sessions);
}

function persistenceRootsFor(transcriptRoots: string[]): string[] {
  const fromEnv = getGrokBotClientPersistenceDir();
  if (fromEnv) return [fromEnv];
  const defaults = getGrokBotTranscriptRoots();
  const usingDefaults =
    transcriptRoots.length === defaults.length &&
    transcriptRoots.every((root, index) => root === defaults[index]);
  return usingDefaults ? [defaultGrokBotClientPersistenceDir()] : [];
}

async function attachClientReplicas(
  sessions: SessionInfo[],
  jsonlByAgent: Map<string, { filePath: string; fileSize: number; fileMtime: string }>,
  transcriptRoots: string[],
  persistenceRoots: string[],
  includeUnreplayable: boolean,
): Promise<void> {
  const seenReplicas = new Set<string>();
  for (const root of await uniqueExistingDirs(persistenceRoots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const agentId = agentIdFromReplicaFilename(entry);
      if (!agentId || isSandSubagentSessionId(agentId)) continue;
      const filePath = join(root, entry);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;
      const resolved = await realpath(filePath).catch(() => filePath);
      if (seenReplicas.has(resolved)) continue;
      seenReplicas.add(resolved);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(filePath, "utf-8"));
      } catch {
        continue;
      }
      const summary = summarizeReplicaDocument(raw);
      if (!summary) continue;
      const prompts = summary.prompts.filter(Boolean);
      if (!includeUnreplayable && prompts.length === 0 && summary.promptCount === 0) continue;

      const existing = sessions.find(
        (session) => session.sessionId === agentId || session.sessionIds?.includes(agentId),
      );
      const jsonl = jsonlByAgent.get(agentId);
      const replicaStamp = newerIso(summary.timestamp, fileStat.mtime.toISOString());
      if (existing) {
        if (!existing.filePaths.includes(filePath)) existing.filePaths.push(filePath);
        existing.timestamp = newerIso(existing.timestamp, replicaStamp) || existing.timestamp;
        if (jsonl && !existing.filePaths.includes(jsonl.filePath))
          existing.filePaths.unshift(jsonl.filePath);
        continue;
      }

      const profile = await readAgentProfile(transcriptRoots[0] || root, agentId);
      const title = profile?.name || summary.title;
      const cwd = profile?.cwd || title || agentId;
      const filePaths = jsonl ? [jsonl.filePath, filePath] : [filePath];
      if (!includeUnreplayable && prompts.length === 0) continue;
      sessions.push({
        provider: "grok-bot",
        sessionId: agentId,
        slug: agentId,
        title,
        project: cwd,
        cwd,
        version: "1",
        timestamp: replicaStamp || fileStat.mtime.toISOString(),
        lineCount: summary.entryCount + (jsonl ? 1 : 0),
        fileSize: fileStat.size + (jsonl?.fileSize || 0),
        filePath: filePaths[0],
        filePaths,
        firstPrompt: prompts[0] || "",
        prompts: prompts.length > 0 ? prompts.slice(0, 2) : undefined,
        promptCount: summary.promptCount,
        ...(profile?.model ? { model: profile.model } : {}),
        ...(prompts.length === 0 ? { transcriptStatus: "no-prompts" as const } : {}),
      });
    }
  }
}

function newerIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (Number.isNaN(a)) return right;
  if (Number.isNaN(b)) return left;
  return a >= b ? left : right;
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
  if (!sessionId || isSandSubagentSessionId(sessionId)) return null;

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
  const groupId = group?.id || profile?.groupId;
  const cwd = profile?.cwd || profile?.name || groupTitle || sessionId;
  const gitRepo = resolveGitRepo && looksLikePath(cwd) ? await readGitRepo(cwd) : profile?.gitRepo;
  const title = groupTitle
    ? `Group: ${groupTitle}`
    : profile?.name || (isSandSubagentSessionId(sessionId) ? "Grok Bot subagent" : undefined);
  const project = groupTitle || cwd;

  return {
    provider: "grok-bot",
    sessionId,
    slug: sessionId,
    title,
    project,
    cwd,
    version: "1",
    ...(groupId ? { groupId } : {}),
    ...(profile?.gitBranch ? { gitBranch: profile.gitBranch } : {}),
    ...(gitRepo ? { gitRepo } : {}),
    timestamp: newerIso(stats.timestamp, fileMtime) || fileMtime,
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
