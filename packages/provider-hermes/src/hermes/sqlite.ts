/// <reference path="../sql-js.d.ts" />
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";

export const HERMES_DIRNAME = ".hermes";
export const HERMES_DB_FILENAME = "state.db";

/**
 * Resolve the Hermes data directory — `~/.hermes` by default. An explicit
 * `HERMES_HOME` env var wins (mirrors how Hermes itself resolves its state).
 * When HERMES_HOME is set, only that single directory is used; otherwise the
 * default home plus every `~/.hermes/profiles/<name>/state.db` is considered.
 */
export function hermesDataDir(): string {
  return process.env.HERMES_HOME || join(homedir(), HERMES_DIRNAME);
}

export function hermesDbPath(): string {
  return join(hermesDataDir(), HERMES_DB_FILENAME);
}

/**
 * All `state.db` paths that belong to this Hermes install: the default home
 * plus every named profile's DB. Respects `HERMES_HOME` — when it is set we
 * only look at that single directory.
 */
export function hermesDbPaths(): string[] {
  const explicit = process.env.HERMES_HOME;
  if (explicit) {
    const p = join(explicit, HERMES_DB_FILENAME);
    return existsSync(p) ? [p] : [];
  }
  const out: string[] = [];
  const defaultDb = hermesDbPath();
  if (existsSync(defaultDb)) out.push(defaultDb);
  const profilesDir = join(hermesDataDir(), "profiles");
  try {
    for (const name of readdirSync(profilesDir)) {
      const p = join(profilesDir, name, HERMES_DB_FILENAME);
      if (!existsSync(p)) continue;
      try {
        if (!statSync(join(profilesDir, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(p);
    }
  } catch {
    // no profiles — ignore
  }
  return out;
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
  let db: Database | null = null;
  try {
    const SQL = await getSqlJs();
    const buffer = await readFile(dbPath);
    if (buffer.length < 1024) return null;
    db = new SQL.Database(buffer);
    // Probe the table layout before handing the handle out: a state.db from an
    // older or unrelated Hermes build could open fine but crash later queries.
    const probe = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages')",
    );
    if (probe.length === 0 || probe[0].values.length !== 2) {
      db.close();
      db = null;
      return null;
    }
    return { db, dbPath };
  } catch {
    db?.close();
    return null;
  }
}

/**
 * Open each known Hermes DB (default + profiles). Useful for discovery and
 * for parsing a session that could live in any profile.
 */
export async function openAllHermesDbs(): Promise<Array<{ db: Database; dbPath: string }>> {
  const paths = hermesDbPaths();
  if (paths.length === 0) return [];
  const out: Array<{ db: Database; dbPath: string }> = [];
  for (const p of paths) {
    const opened = await openHermesDb(p);
    if (opened) out.push(opened);
  }
  return out;
}

/** True when the session id looks like a Hermes session id (`YYYYMMDD_HHMMSS_...`). */
export function isHermesSessionId(value: string): boolean {
  return /^\\d{8}_\\d{6}_/.test(value) || value.startsWith("session_");
}
