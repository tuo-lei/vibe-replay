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
