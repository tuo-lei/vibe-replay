import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_ENVELOPE_VERSION = 1;
const CACHE_DIR = join(homedir(), ".vibe-replay", "cache");
let configuredAppVersion: string | undefined;

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

export interface FileCacheOptions {
  appVersion?: string;
}

export function setFileCacheAppVersion(appVersion: string): void {
  configuredAppVersion = appVersion;
}

function currentAppVersion(options?: FileCacheOptions): string {
  return options?.appVersion || configuredAppVersion || process.env.npm_package_version || "0.0.0";
}

function toCachePath(key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CACHE_DIR, `${safeKey}.json`);
}

export async function readFileCache<T>(
  key: string,
  options?: FileCacheOptions,
): Promise<FileCacheEntry<T> | null> {
  if (isFileCacheDisabled()) return null;
  try {
    const raw = await readFile(toCachePath(key), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    if (
      parsed.envelopeVersion !== CACHE_ENVELOPE_VERSION ||
      parsed.appVersion !== currentAppVersion(options) ||
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

export async function writeFileCache<T>(
  key: string,
  data: T,
  options?: FileCacheOptions,
): Promise<void> {
  if (isFileCacheDisabled()) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const payload: CacheEnvelope<T> = {
      envelopeVersion: CACHE_ENVELOPE_VERSION,
      appVersion: currentAppVersion(options),
      updatedAt: new Date().toISOString(),
      data,
    };
    await writeFile(toCachePath(key), JSON.stringify(payload), "utf-8");
  } catch {
    // Best-effort cache writes should never break core flows.
  }
}
