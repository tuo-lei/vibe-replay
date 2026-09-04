import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo } from "@vibe-replay/provider-core/utils";
import { getGrokBotTranscriptRoots } from "./config.js";
import { countGrokBotDiscoveryStats } from "./parser.js";

interface AgentProfile {
  name?: string;
  cwd?: string;
  gitBranch?: string;
  gitRepo?: string;
  model?: string;
  groupTitle?: string;
  groupId?: string;
}

interface AgentGroup {
  title?: string;
  id?: string;
  participants?: string[];
}

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
  return sessions;
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

export async function readAgentProfile(
  transcriptsRoot: string,
  agentId: string,
): Promise<AgentProfile | undefined> {
  const candidates = [
    join(dirname(transcriptsRoot), "agents", agentId, "profile.json"),
    join(transcriptsRoot, "agents", agentId, "profile.json"),
  ];
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf-8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name.trim() : undefined;
      const cwd =
        firstString(obj.cwd, obj.workspace, obj.project, obj.projectPath, obj.working_directory) ||
        (name && looksLikePath(name) ? name : undefined);
      const gitBranch = firstString(obj.gitBranch, obj.git_branch, obj.branch);
      const gitRepo = firstString(obj.gitRepo, obj.git_repo, obj.repo);
      const model = firstString(obj.model, obj.modelId, obj.model_id);
      const groupTitle = firstString(
        obj.groupTitle,
        obj.group_title,
        obj.roomTitle,
        obj.room_title,
        nestedTitle(obj.group),
      );
      const groupId = firstString(obj.groupId, obj.group_id, nestedId(obj.group));
      if (name || cwd || gitBranch || gitRepo || model || groupTitle || groupId) {
        return {
          ...(name ? { name } : {}),
          ...(cwd ? { cwd } : {}),
          ...(gitBranch ? { gitBranch } : {}),
          ...(gitRepo ? { gitRepo } : {}),
          ...(model ? { model } : {}),
          ...(groupTitle ? { groupTitle } : {}),
          ...(groupId ? { groupId } : {}),
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readAgentGroup(
  transcriptsRoot: string,
  agentId: string,
  profile?: AgentProfile,
): Promise<AgentGroup | undefined> {
  const candidates = [
    join(dirname(transcriptsRoot), "agents", agentId, "group.json"),
    join(transcriptsRoot, "agents", agentId, "group.json"),
  ];
  if (profile?.groupId) {
    candidates.push(
      join(dirname(transcriptsRoot), "agents", profile.groupId, "group.json"),
      join(dirname(transcriptsRoot), "groups", profile.groupId, "group.json"),
    );
  }
  for (const candidate of candidates) {
    const parsed = await readGroupFile(candidate);
    if (parsed) return parsed;
  }
  if (profile?.groupTitle) {
    return { title: profile.groupTitle, ...(profile.groupId ? { id: profile.groupId } : {}) };
  }
  return undefined;
}

async function readGroupFile(path: string): Promise<AgentGroup | undefined> {
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    const title = firstString(
      obj.title,
      obj.name,
      obj.groupTitle,
      obj.group_title,
      obj.roomTitle,
      obj.room_title,
      nestedTitle(obj.group),
    );
    const id = firstString(obj.id, obj.groupId, obj.group_id, nestedId(obj.group));
    const participants = collectParticipantNames(obj.participants ?? obj.members);
    if (title || id || participants.length > 0) {
      return {
        ...(title ? { title } : {}),
        ...(id ? { id } : {}),
        ...(participants.length > 0 ? { participants } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function collectParticipantNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) names.push(item.trim());
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const name = firstString(record.name, record.title);
      if (name) names.push(name);
    }
  }
  return names;
}

function nestedTitle(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return firstString(obj.title, obj.name, obj.groupTitle, obj.roomTitle);
}

function nestedId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return firstString(obj.id, obj.groupId, obj.group_id);
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
