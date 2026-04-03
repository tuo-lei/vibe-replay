import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "./version.js";

const CACHE_ENVELOPE_VERSION = 1;
const CACHE_DIR = join(homedir(), ".vibe-replay", "cache");

function isFileCacheDisabled(): boolean {
  return process.env.VIBE_REPLAY_DISABLE_FILE_CACHE === "1";
}

interface CacheEnvelope<T> {
  envelopeVersion: number;
  appVersion: string;
  updatedAt: string;
  data: T;
}

export interface FileCacheEntry<T> {
  updatedAt: string;
  data: T;
}

function toCachePath(key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CACHE_DIR, `${safeKey}.json`);
}

export async function readFileCache<T>(key: string): Promise<FileCacheEntry<T> | null> {
  if (isFileCacheDisabled()) return null;
  try {
    const raw = await readFile(toCachePath(key), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    if (
      parsed.envelopeVersion !== CACHE_ENVELOPE_VERSION ||
      parsed.appVersion !== CLI_VERSION ||
      typeof parsed.updatedAt !== "string" ||
      !("data" in parsed)
    ) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, data: parsed.data as T };
  } catch {
    return null;
  }
}

export async function writeFileCache<T>(key: string, data: T): Promise<void> {
  if (isFileCacheDisabled()) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const payload: CacheEnvelope<T> = {
      envelopeVersion: CACHE_ENVELOPE_VERSION,
      appVersion: CLI_VERSION,
      updatedAt: new Date().toISOString(),
      data,
    };
    await writeFile(toCachePath(key), JSON.stringify(payload), "utf-8");
  } catch {
    // Best-effort cache writes should never break core flows.
  }
}
