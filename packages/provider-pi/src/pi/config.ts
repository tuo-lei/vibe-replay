import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const DEFAULT_PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const DEFAULT_OMP_AGENT_DIR = join(homedir(), ".omp", "agent");

function getConfiguredAgentDir(): string | undefined {
  const value = process.env.PI_CODING_AGENT_DIR?.trim();
  return value || undefined;
}

function getConfiguredSessionsDir(): string | undefined {
  const value = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  return value || undefined;
}

function getPiAgentDir(): string {
  return getConfiguredAgentDir() || DEFAULT_PI_AGENT_DIR;
}

export function getPiAgentDirs(): string[] {
  const configured = getConfiguredAgentDir();
  return configured ? [configured] : [DEFAULT_PI_AGENT_DIR, DEFAULT_OMP_AGENT_DIR];
}

export function getPiSessionsDirs(): string[] {
  const configured = getConfiguredSessionsDir();
  if (configured) return [configured];
  return getPiAgentDirs().map((agentDir) => join(agentDir, "sessions"));
}

/**
 * Keep the historical single-root API for callers that need one default path.
 * Discovery uses getPiSessionsDirs() so Pi and OMP can coexist.
 */
export function getPiSessionsDir(): string {
  return getPiSessionsDirs()[0];
}

export function getPiSessionsDirForSession(filePath: string): string {
  const absolutePath = resolve(filePath);
  const root = getPiSessionsDirs().find((sessionsDir) => {
    const absoluteRoot = resolve(sessionsDir);
    return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
  });
  return root || getPiSessionsDir();
}

export function getPiAgentDirForSession(filePath: string): string {
  const absolutePath = resolve(filePath);
  const roots = getPiSessionsDirs();
  const root = roots.find((sessionsDir) => {
    const absoluteRoot = resolve(sessionsDir);
    return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`);
  });
  return root ? dirname(root) : getPiAgentDir();
}

export async function readPiModelContextWindows(
  agentDir = getPiAgentDir(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let raw: string;
  try {
    raw = await readFile(join(agentDir, "models.json"), "utf-8");
  } catch {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }

  collectModelContextWindows(parsed, result);
  return result;
}

function collectModelContextWindows(value: unknown, result: Map<string, number>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectModelContextWindows(item, result);
    return;
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "string" && typeof obj.contextWindow === "number") {
    result.set(obj.id, obj.contextWindow);
  }
  for (const nested of Object.values(obj)) collectModelContextWindows(nested, result);
}
