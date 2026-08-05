/// <reference path="../sql-js.d.ts" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";

export const HERMES_DIRNAME = ".hermes";
export const HERMES_DB_FILENAME = "state.db";

/**
 * Resolve the Hermes data directory — `~/.hermes` by default. An explicit
 * `HERMES_HOME` env var wins (mirrors how Hermes itself resolves its state).
 */
export function hermesDataDir(): string {
  return process.env.HERMES_HOME || join(homedir(), HERMES_DIRNAME);
}

export function hermesDbPath(): string {
  return join(hermesDataDir(), HERMES_DB_FILENAME);
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
 * Open the Hermes SQLite database with sql.js (WASM). Returns null when the
 * DB file is missing or unreadable, or when the table layout is unknown.
 */
export async function openHermesDb(
  dbPath = hermesDbPath(),
): Promise<{ db: Database; dbPath: string } | null> {
  try {
    const SQL = await getSqlJs();
    const buffer = await readFile(dbPath);
    if (buffer.length < 1024) return null;
    const db = new SQL.Database(buffer);
    // Probe the table layout before handing the handle out: a state.db from an
    // older or unrelated Hermes build could open fine but crash later queries.
    const probe = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages')",
    );
    if (probe.length === 0 || probe[0].values.length !== 2) {
      db.close();
      return null;
    }
    return { db, dbPath };
  } catch {
    return null;
  }
}

/** True when the session id looks like a Hermes session id (`YYYYMMDD_HHMMSS_...`). */
export function isHermesSessionId(value: string): boolean {
  return /^\d{8}_\d{6}_/.test(value) || value.startsWith("session_");
}
