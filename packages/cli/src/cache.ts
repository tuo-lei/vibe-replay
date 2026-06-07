import { readFileCache as readCoreFileCache } from "@vibe-replay/provider-core/cache";
import { writeFileCache as writeCoreFileCache } from "@vibe-replay/provider-core/cache";
import { CLI_VERSION } from "./version.js";
export type { FileCacheEntry } from "@vibe-replay/provider-core/cache";

export async function readFileCache<T>(key: string) {
  return readCoreFileCache<T>(key, { appVersion: CLI_VERSION });
}

export async function writeFileCache<T>(key: string, data: T) {
  return writeCoreFileCache<T>(key, data, { appVersion: CLI_VERSION });
}
