/// <reference path="../sql-js.d.ts" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";

export const OPENCODE_DIRNAME = "opencode";
export const OPENCODE_DB_FILENAME = "opencode.db";

/**
 * Resolve the opencode data directory. opencode stores its SQLite database
 * under the XDG data dir — `~/.local/share/opencode` on macOS/Linux,
 * `%LOCALAPPDATA%\opencode` on Windows. An explicit `OPENCODE_DATA` env var wins.
 */
export function opencodeDataDir(): string {
  if (process.env.OPENCODE_DATA) return process.env.OPENCODE_DATA;
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), "AppData", "Local"),
      OPENCODE_DIRNAME,
    );
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), OPENCODE_DIRNAME);
}

export function opencodeDbPath(): string {
  return join(opencodeDataDir(), OPENCODE_DB_FILENAME);
}

export function createRetryableInit<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return async () => {
    if (!promise) {
      promise = factory().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

const getSqlJs = createRetryableInit<SqlJsStatic>(async () => {
  const mod = await import("sql.js");
  return mod.default();
});

/**
 * Open the opencode SQLite database with sql.js (WASM). Returns null when the
 * DB file is missing or unreadable, or when the table layout is unknown.
 */
export async function openOpencodeDb(
  dbPath = opencodeDbPath(),
): Promise<{ db: Database; dbPath: string } | null> {
  try {
    const SQL = await getSqlJs();
    const buffer = await readFile(dbPath);
    if (buffer.length < 1024) return null;
    const db = new SQL.Database(buffer);
    return { db, dbPath };
  } catch {
    return null;
  }
}

/** True when the session id looks like an opencode session id (`ses_...`). */
export function isOpencodeSessionId(value: string): boolean {
  return value.startsWith("ses_");
}
