import { createHash } from "node:crypto";
import { basename } from "node:path";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import type { ReplaySession, SessionInfo, SessionLocation } from "./types.js";

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
  return shortenPath(project);
}

// Keep cloud sync requests comfortably below the current D1 bind / batch ceiling.
export const MAX_INSIGHTS_SYNC_DAYS_PER_REQUEST = 90;

function chunkItems<T>(items: T[], maxItems: number): T[][] {
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
  targetId?: string;
}

const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate an optional SSH source id while preserving the no-target case. */
export function safeTargetId(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const trimmed = raw.trim();
  return TARGET_ID_RE.test(trimmed) && trimmed !== "local" ? trimmed : null;
}

/** A replay must contain at least one real user prompt, not only metadata/context. */
export function hasReplayableContent(replay: Pick<ReplaySession, "meta" | "scenes">): boolean {
  const sceneCount = replay.scenes.length;
  const userPrompts = replay.scenes.filter((scene) => scene.type === "user-prompt").length;
  return sceneCount > 0 && userPrompts > 0;
}

export interface ResolvedGenerateInputs {
  paths: string[];
  sessionInfo?: SessionInfo;
}

export type GenerateInputResolution =
  | { ok: true; value: ResolvedGenerateInputs }
  | { ok: false; error: string };

/**
 * Keep generated SSH replay directories unique by location and native session
 * identity. Hashes avoid exposing the configured target id in output paths.
 */
export function replayOutputSlug(
  rawSlug: string,
  location?: SessionLocation,
  identity?: Pick<SessionInfo, "provider" | "sessionId">,
): string {
  const slug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-") || "session";
  if (location?.kind !== "ssh") return slug;
  const locationSuffix = createHash("sha1").update(location.id).digest("hex").slice(0, 10);
  const identitySuffix = identity
    ? `--id-${createHash("sha1")
        .update(`${identity.provider}\0${identity.sessionId}`)
        .digest("hex")
        .slice(0, 10)}`
    : "";
  return `${slug}--ssh-${locationSuffix}${identitySuffix}`;
}

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
  if (body.targetId !== undefined) {
    if (
      typeof body.targetId !== "string" ||
      safeTargetId(body.targetId) === null ||
      safeTargetId(body.targetId) === undefined
    ) {
      return { ok: false, error: "targetId must be a valid SSH source id" };
    }
  }
  const requestedTargetId = safeTargetId(body.targetId);
  const matchesRequestedLocation = (session: SessionInfo): boolean =>
    requestedTargetId
      ? session.location?.kind === "ssh" && session.location.id === requestedTargetId
      : session.location?.kind !== "ssh";

  let sessionInfo: SessionInfo | undefined;
  if (requestedSessionSlug) {
    const slugMatches = discoveredSessions.filter(
      (s) =>
        s.provider === body.provider &&
        s.slug === requestedSessionSlug &&
        matchesRequestedLocation(s),
    );
    if (requestedSessionProject) {
      sessionInfo = slugMatches.find(
        (s) => normalizeProjectPath(s.project) === requestedSessionProject,
      );
    } else if (slugMatches.length === 1) {
      sessionInfo = slugMatches[0];
    }
  }
  // Fallback: match by sessionId (covers old JSONL files where slug differs from replay slug)
  if (!sessionInfo && typeof body.sessionId === "string" && body.sessionId) {
    sessionInfo = discoveredSessions.find(
      (s) =>
        s.provider === body.provider &&
        s.sessionId === body.sessionId &&
        matchesRequestedLocation(s),
    );
  }

  if (sessionInfo?.transcriptStatus) {
    return {
      ok: false,
      error:
        sessionInfo.transcriptStatus === "no-prompts"
          ? "This session has no replayable user prompts"
          : "This session transcript is unavailable or unreadable",
    };
  }

  if (requestedTargetId && !sessionInfo) {
    return { ok: false, error: "SSH source session could not be resolved" };
  }

  const fallbackFilePaths = sessionInfo?.filePaths || [];
  const fallbackToolPaths = sessionInfo?.toolPaths || [];
  if (sessionInfo?.location?.kind === "ssh") {
    const allowedPaths = new Set([...fallbackFilePaths, ...fallbackToolPaths]);
    const explicitPaths = [...filePaths, ...toolPaths];
    if (explicitPaths.some((path) => !allowedPaths.has(path))) {
      return {
        ok: false,
        error: "Requested paths do not belong to the selected SSH source session",
      };
    }
  }
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
