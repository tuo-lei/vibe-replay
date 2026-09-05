import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AgentProfile {
  name?: string;
  cwd?: string;
  gitBranch?: string;
  gitRepo?: string;
  model?: string;
  groupTitle?: string;
  groupId?: string;
}

export interface AgentGroup {
  title?: string;
  id?: string;
  participants?: string[];
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

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
