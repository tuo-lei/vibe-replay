import { homedir } from "node:os";

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

/** Extract file path from tool input, handling different provider field names. */
export function extractToolFilePath(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const fp = input?.file_path ?? input?.filePath ?? input?.path ?? input?.relativeWorkspacePath;
  return typeof fp === "string" && fp.trim() ? fp : undefined;
}
