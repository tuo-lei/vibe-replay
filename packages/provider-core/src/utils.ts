import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
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
