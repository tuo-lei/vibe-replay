import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getPiSessionsDir(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR || join(getPiAgentDir(), "sessions");
}

export async function readPiModelContextWindows(): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let raw: string;
  try {
    raw = await readFile(join(getPiAgentDir(), "models.json"), "utf-8");
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
