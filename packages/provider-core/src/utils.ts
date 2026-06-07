import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Replace $HOME prefix with `~` for display. */
export function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
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
    const config = await readFile(join(resolved, ".git", "config"), "utf-8");
    const match = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
    if (!match) return undefined;
    return normalizeGitUrl(match[1].trim());
  } catch {
    return undefined;
  }
}

/** Normalize a git remote URL to "owner/repo" format. */
export function normalizeGitUrl(url: string): string | undefined {
  // SCP-style ssh: git@github.com:org/repo.git
  const scpMatch = url.match(/:([^/][^:]+?)(?:\.git)?\s*$/);
  if (!url.startsWith("http") && !url.startsWith("ssh://") && scpMatch) {
    const path = scpMatch[1];
    const parts = path.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  }
  // https/ssh-protocol: https://github.com/org/repo.git or ssh://git@github.com/org/repo
  try {
    const parsed = new URL(url);
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
