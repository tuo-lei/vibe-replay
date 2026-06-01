import { homedir } from "node:os";
import { basename } from "node:path";
import type { SessionInfo } from "./types.js";

/** Sanitize slug to prevent path traversal — rejects anything that isn't a simple name */
export function safeSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  const clean = basename(raw);
  if (!clean || clean !== raw || clean === "." || clean === "..") return null;
  return clean;
}

/** Require a valid slug from query param, returning 400 if missing */
export function requireSlug(raw: string | undefined): { slug: string } | { error: string } {
  const slug = safeSlug(raw);
  if (!slug) return { error: "slug parameter is required" };
  return { slug };
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function normalizeProjectPath(project: string): string {
  const home = homedir();
  return project.startsWith(home) ? `~${project.slice(home.length)}` : project;
}

// Keep cloud sync requests comfortably below the current D1 bind / batch ceiling.
export const MAX_INSIGHTS_SYNC_DAYS_PER_REQUEST = 90;

export function chunkItems<T>(items: T[], maxItems: number): T[][] {
  if (maxItems <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxItems) {
    chunks.push(items.slice(i, i + maxItems));
  }
  return chunks;
}

export function buildInsightsSyncBatches<T extends { date: string }>(
  days: T[],
  existingDates: Iterable<string>,
  today: string,
  maxDaysPerBatch = MAX_INSIGHTS_SYNC_DAYS_PER_REQUEST,
): T[][] {
  const existing = new Set(existingDates);
  const pending = days.filter((day) => !existing.has(day.date) || day.date === today);
  return chunkItems(pending, maxDaysPerBatch);
}

export interface GenerateRequestBody {
  provider: string;
  filePaths?: unknown;
  toolPaths?: unknown;
  title?: unknown;
  sessionSlug?: string;
  sessionProject?: string;
  sessionId?: string;
}

interface ResolvedGenerateInputs {
  paths: string[];
  sessionInfo?: SessionInfo;
}

export type GenerateInputResolution =
  | { ok: true; value: ResolvedGenerateInputs }
  | { ok: false; error: string };

function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== "string")) return null;
  return value;
}

export function resolveGenerateInputs(
  body: GenerateRequestBody,
  discoveredSessions: SessionInfo[],
): GenerateInputResolution {
  const filePaths = toStringArray(body.filePaths);
  if (!filePaths) {
    return { ok: false, error: "filePaths must be an array of strings" };
  }
  const toolPaths = toStringArray(body.toolPaths);
  if (!toolPaths) {
    return { ok: false, error: "toolPaths must be an array of strings" };
  }

  const requestedSessionSlug =
    typeof body.sessionSlug === "string" ? safeSlug(body.sessionSlug) : null;
  const requestedSessionProject =
    typeof body.sessionProject === "string" ? normalizeProjectPath(body.sessionProject) : undefined;

  let sessionInfo: SessionInfo | undefined;
  if (requestedSessionSlug) {
    const slugMatches = discoveredSessions.filter((s) => s.slug === requestedSessionSlug);
    if (requestedSessionProject) {
      sessionInfo = slugMatches.find(
        (s) => normalizeProjectPath(s.project) === requestedSessionProject,
      );
    }
    sessionInfo = sessionInfo || slugMatches[0];
  }
  // Fallback: match by sessionId (covers old JSONL files where slug differs from replay slug)
  if (!sessionInfo && typeof body.sessionId === "string" && body.sessionId) {
    sessionInfo = discoveredSessions.find((s) => s.sessionId === body.sessionId);
  }

  const fallbackFilePaths = sessionInfo?.filePaths || [];
  const fallbackToolPaths = sessionInfo?.toolPaths || [];
  const paths = [
    ...(filePaths.length > 0 ? filePaths : fallbackFilePaths),
    ...(toolPaths.length > 0 ? toolPaths : fallbackToolPaths),
  ];

  const hasCursorSessionFallback = body.provider === "cursor" && Boolean(sessionInfo?.sessionId);
  if (paths.length === 0 && !hasCursorSessionFallback) {
    return {
      ok: false,
      error:
        "filePaths is required (or provide a resolvable Cursor sessionSlug for SQLite/global-state sessions)",
    };
  }

  return {
    ok: true,
    value: {
      paths,
      sessionInfo,
    },
  };
}
