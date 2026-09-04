/// <reference path="../sql-js.d.ts" />
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";
import type { Dirent } from "node:fs";

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

function resolveExisting(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Root directory that holds the default DB and the named profiles — mirrors
 * Hermes's own `get_default_hermes_root()`:
 *
 * - No `HERMES_HOME`: root is `~/.hermes`.
 * - `HERMES_HOME` inside `~/.hermes` (profile mode, e.g. a path under
 *   `~/.hermes/profiles/`): root stays `~/.hermes` so all profiles are visible.
 * - `HERMES_HOME` outside `~/.hermes` (Docker/custom deployment): root is
 *   `HERMES_HOME` itself — unless it points at `<root>/profiles/<name>`, in
 *   which case root is that grandparent.
 */
export function hermesRootDir(): string {
  const envHome = process.env.HERMES_HOME;
  const nativeHome = join(homedir(), HERMES_DIRNAME);
  if (!envHome) return nativeHome;
  const envPath = resolveExisting(resolve(envHome));
  const rel = relative(resolveExisting(nativeHome), envPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return nativeHome;
  }
  if (basename(dirname(envPath)) === "profiles") {
    return dirname(dirname(envPath));
  }
  return envPath;
}

/**
 * Directory for a named Hermes profile (`<root>/profiles/<name>`).
 * Returns undefined for empty or path-like names so Bot Chat project labels
 * cannot be steered with `../` or separators in `profile_name`.
 */
export function hermesProfileDir(profileName: string | null | undefined): string | undefined {
  const name = profileName?.trim();
  if (!name || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
  return join(hermesRootDir(), "profiles", name);
}

/**
 * All `state.db` paths that belong to this Hermes install: the default home
 * plus every named profile's DB (`<root>/profiles/<name>/state.db`). Missing
 * locations are skipped so partial installs still work.
 */
export function hermesDbPaths(): string[] {
  const out: string[] = [];
  const defaultDb = join(hermesRootDir(), HERMES_DB_FILENAME);
  if (existsSync(defaultDb)) out.push(defaultDb);
  const profilesDir = join(hermesRootDir(), "profiles");
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    // no profiles dir — default DB only
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = join(profilesDir, entry.name, HERMES_DB_FILENAME);
    if (existsSync(p)) out.push(p);
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
  return /^\d{8}_\d{6}_/.test(value) || value.startsWith("session_");
}
