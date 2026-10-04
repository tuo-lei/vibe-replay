import type { SessionInfo } from "@vibe-replay/provider-contract";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** UTF-8 byte size without retaining or exposing the underlying content. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

/** UTF-8 byte size of a JSON payload. Unserializable values report zero. */
export function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : utf8ByteLength(serialized);
  } catch {
    return 0;
  }
}

/** Replace an OS home-directory prefix with `~` for display. */
export function shortenPath(
  path: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedHome = home.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalizedHome) return path;

  const escapedHome = normalizedHome
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", platform === "win32" ? "[\\\\/]" : "/");
  const flags = platform === "win32" ? "gi" : "g";
  const homePattern = new RegExp(`(^|[^A-Za-z0-9._-])${escapedHome}(?![A-Za-z0-9._-])`, flags);

  return path.replace(homePattern, (_match, prefix: string) => `${prefix}~`);
}

const MAX_TITLE_CHARS = 120;

/** Collapse whitespace and trim a title string. Returns `undefined` for empty input. */
export function normalizeTitle(value?: string): string | undefined {
  const cleaned = (value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  return cleaned || undefined;
}

/** Tool names that modify files on disk. Used to count edits and track modified files. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Delete",
]);

/** Matches a JSONL record's `"type": "tool_use"` field for cheap regex-based counting. */
export const TOOL_USE_RE = /"type"\s*:\s*"tool_use"/g;

/** Extract file path from tool input, handling different provider field names. */
export function extractToolFilePath(
  input: Record<string, unknown> | undefined,
): string | undefined {
  return extractToolFilePaths(input)[0];
}

/** Extract one or more file paths from tool input, handling provider-specific field names. */
export function extractToolFilePaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const plural = input.file_paths ?? input.filePaths ?? input.paths;
  const paths = Array.isArray(plural)
    ? plural.filter((fp): fp is string => typeof fp === "string" && fp.trim().length > 0)
    : [];
  const singular = input.file_path ?? input.filePath ?? input.path ?? input.relativeWorkspacePath;
  if (typeof singular === "string" && singular.trim()) paths.unshift(singular);
  return [...new Set(paths)];
}

/**
 * Format a timestamp as YYYY-MM-DD in the local timezone.
 * Critical for day-bucketing: slicing an ISO string gives UTC, which shifts
 * evening activity to the next day for users west of UTC.
 */
export function localDayKey(input: string | Date | number | undefined | null): string | undefined {
  if (input == null || input === "") return undefined;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Read the git remote origin URL from a project directory's .git/config
 * and normalize it to "owner/repo" format. Returns undefined if the directory
 * is not a git repo or has no origin remote.
 *
 * Supports:
 *   https://github.com/org/repo.git → org/repo
 *   git@github.com:org/repo.git     → org/repo
 *   ssh://git@github.com/org/repo   → org/repo
 */
export async function readGitRepo(projectDir: string): Promise<string | undefined> {
  if (!projectDir.trim()) return undefined;
  try {
    const resolved = projectDir.startsWith("~") ? join(homedir(), projectDir.slice(1)) : projectDir;
    const gitPath = join(resolved, ".git");
    let configPath = join(gitPath, "config");

    // In git worktrees, `.git` is a file containing `gitdir: <path>` instead
    // of a directory. The remote config lives in the common git dir.
    const gitStat = await stat(gitPath).catch(() => null);
    if (gitStat?.isFile()) {
      const gitFile = await readFile(gitPath, "utf-8");
      const gitdirMatch = gitFile.match(/^gitdir:\s*(.+)$/m);
      if (!gitdirMatch) return undefined;
      const gitdir = gitdirMatch[1].trim();
      const absoluteGitdir = isAbsolute(gitdir) ? gitdir : resolve(resolved, gitdir);
      const commonDir = await readFile(join(absoluteGitdir, "commondir"), "utf-8").catch(
        () => "../..",
      );
      configPath = join(resolve(absoluteGitdir, commonDir.trim()), "config");
    }

    const config = await readFile(configPath, "utf-8");
    const match = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
    if (!match) return undefined;
    return normalizeGitUrl(match[1].trim());
  } catch {
    return undefined;
  }
}

/** Normalize a git remote URL to "owner/repo" format. */
export function normalizeGitUrl(url: string): string | undefined {
  const trimmed = url.trim();
  // SCP-style ssh: git@github.com:org/repo.git
  const scpMatch = trimmed.match(/:([^/][^:]+?)(?:\.git)?\s*$/);
  if (!trimmed.startsWith("http") && !trimmed.startsWith("ssh://") && scpMatch) {
    const path = scpMatch[1];
    const parts = path.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  }
  // https/ssh-protocol: https://github.com/org/repo.git or ssh://git@github.com/org/repo
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } catch {
    // not a valid URL
  }
  return undefined;
}

export class SqliteSnapshotRequiredError extends Error {
  constructor(
    message: string,
    readonly sessions: SessionInfo[] = [],
  ) {
    super(message);
    this.name = "SqliteSnapshotRequiredError";
  }
}

interface SqliteReadScope {
  snapshots: Map<string, Promise<{ source: string; directory: string }>>;
}
const sqliteNoWrites = new AsyncLocalStorage<SqliteReadScope>();
const sqliteOperationSnapshots = new AsyncLocalStorage<SqliteReadScope>();

/** Reuse checkpointed copies during ordinary operations without rejecting coordinated live WAL. */
export function withSqliteSnapshotScope<T>(action: () => Promise<T>): Promise<T> {
  if (sqliteNoWrites.getStore() || sqliteOperationSnapshots.getStore()) return action();
  const scope: SqliteReadScope = { snapshots: new Map() };
  return sqliteOperationSnapshots.run(scope, async () => {
    try {
      return await action();
    } finally {
      for (const pending of scope.snapshots.values()) {
        const snapshot = await pending.catch(() => null);
        if (snapshot) await rm(snapshot.directory, { recursive: true, force: true });
      }
    }
  });
}

/** Carry the zero-write contract through async provider discovery and parsing. */
export function withReadOnlySqlite<T>(readOnly: boolean, action: () => Promise<T>): Promise<T> {
  if (!readOnly || sqliteNoWrites.getStore()) return action();
  const scope: SqliteReadScope = { snapshots: new Map() };
  return sqliteNoWrites.run(scope, async () => {
    try {
      return await action();
    } finally {
      for (const pending of scope.snapshots.values()) {
        const snapshot = await pending.catch(() => null);
        if (snapshot) await rm(snapshot.directory, { recursive: true, force: true });
      }
    }
  });
}

async function stageSqliteSnapshot(path: string): Promise<{ source: string; directory: string }> {
  if (!sqliteNoWrites.getStore()) return withReadOnlySqlite(true, () => stageSqliteSnapshot(path));
  await assertSqliteWalReadable(path);
  const before = await stat(path, { bigint: true });
  const directory = await mkdtemp(join(tmpdir(), "vibe-sqlite-snapshot-"));
  try {
    const snapshot = join(directory, "source.db");
    await copyFile(path, snapshot, constants.COPYFILE_FICLONE);
    await assertSqliteWalReadable(path);
    const after = await stat(path, { bigint: true });
    if (
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new SqliteSnapshotRequiredError(
        "The database changed while acquiring a snapshot. Retry after the source application is idle or checkpointed, or use an already saved replay.",
      );
    return { source: `${pathToFileURL(snapshot).href}?immutable=1`, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** WASM snapshots stay in memory but still reject concurrent source changes. */
export async function readSqliteSnapshot(path: string): Promise<Buffer> {
  const validate = sqliteNoWrites.getStore()
    ? assertSqliteWalReadable
    : assertSqliteRollbackReadable;
  await validate(path);
  const before = await stat(path, { bigint: true });
  const bytes = await readFile(path);
  await validate(path);
  const after = await stat(path, { bigint: true });
  if (
    before.size !== after.size ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new SqliteSnapshotRequiredError(
      "The database changed while acquiring a snapshot. Retry after the source application is idle or checkpointed, or use an already saved replay.",
    );
  return bytes;
}

/** Native queries use a validated private copy; immutable never names a live DB. */
export async function withSqliteReadSource<T>(
  path: string,
  action: (source: string) => Promise<T>,
): Promise<T> {
  await assertSqliteWalReadable(path);
  if (!existsSync(path)) return action(path);
  path = realpathSync(path);
  const readOnlyScope = sqliteNoWrites.getStore();
  const scope = readOnlyScope || sqliteOperationSnapshots.getStore();
  if (
    !readOnlyScope &&
    !scope?.snapshots.has(path) &&
    existsSync(`${path}-wal`) &&
    (await stat(`${path}-wal`)).size > 0
  ) {
    await assertSqliteWalReadable(path);
    return action(path);
  }
  if (scope) {
    let pending = scope.snapshots.get(path);
    if (!pending) {
      pending = stageSqliteSnapshot(path);
      scope.snapshots.set(path, pending);
    }
    return action((await pending).source);
  }
  const snapshot = await stageSqliteSnapshot(path);
  try {
    return await action(snapshot.source);
  } finally {
    await rm(snapshot.directory, { recursive: true, force: true });
  }
}

/** Pending rollback pages cannot be recovered from a main-file-only snapshot. */
async function assertSqliteRollbackReadable(path: string): Promise<void> {
  path = existsSync(path) ? realpathSync(path) : path;
  if (!existsSync(`${path}-journal`)) return;
  const journal = await open(`${path}-journal`, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new SqliteSnapshotRequiredError(
      "Cannot verify the SQLite rollback journal. Finish the source transaction or recovery, or use an already saved replay.",
    );
  });
  if (!journal) return;
  try {
    // SQLite PERSIST commits by zeroing the 28-byte header while retaining
    // old page bytes. A nonempty file alone is therefore not an active journal.
    const header = Buffer.alloc(28);
    const { bytesRead } = await journal.read(header, 0, header.length, 0);
    if (header.subarray(0, bytesRead).some((byte) => byte !== 0))
      throw new SqliteSnapshotRequiredError(
        "The database has a pending rollback journal. Finish the transaction or let the source application recover it, or use an already saved replay.",
      );
  } catch (error) {
    if (error instanceof SqliteSnapshotRequiredError) throw error;
    throw new SqliteSnapshotRequiredError(
      "Cannot verify the SQLite rollback journal. Finish the source transaction or recovery, or use an already saved replay.",
    );
  } finally {
    await journal.close();
  }
}

/** SQLite's readonly queries may need journal recovery or a WAL sidecar write. */
export async function assertSqliteWalReadable(path: string): Promise<void> {
  // SQLite resolves file symlinks before selecting the WAL/SHM filenames.
  path = existsSync(path) ? realpathSync(path) : path;
  await assertSqliteRollbackReadable(path);
  if (!existsSync(`${path}-wal`)) return;
  const wal = await stat(`${path}-wal`);
  if (wal.size === 0) return;
  if (sqliteNoWrites.getStore())
    throw new SqliteSnapshotRequiredError(
      "Read-only export and preflight cannot query an active WAL because SQLite may change its shared-memory sidecar. Checkpoint it in the source application, or use an already saved replay.",
    );
  if (!existsSync(`${path}-shm`) || !(await stat(`${path}-shm`)).isFile())
    throw new Error(
      "The database has an active WAL but no shared-memory sidecar. Checkpoint it in the source application, or use an already saved replay; a read-only query could otherwise create a -shm file.",
    );
}

/** URI formatting for frozen snapshots; native live-source readers use withSqliteReadSource. */
export async function sqliteReadOnlyLocation(path: string): Promise<string> {
  await assertSqliteWalReadable(path);
  if (!existsSync(path)) return path;
  path = realpathSync(path);
  if (existsSync(`${path}-wal`) && (await stat(`${path}-wal`)).size > 0) {
    await assertSqliteWalReadable(path);
    if (!sqliteNoWrites.getStore()) return path;
  }
  return `${pathToFileURL(path).href}?immutable=1`;
}

/** WASM readers cannot apply WAL frames; zero-write flows require a current snapshot. */
export async function assertSqliteSnapshotCurrent(path: string): Promise<void> {
  await assertSqliteRollbackReadable(path);
  if (sqliteNoWrites.getStore()) await assertSqliteWalReadable(path);
}
