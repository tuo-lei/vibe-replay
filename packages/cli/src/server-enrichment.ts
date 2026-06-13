/**
 * Source-enrichment and scan-prioritization helpers for the dashboard server.
 *
 * Pure functions extracted from server.ts: they rank which Cursor sessions to
 * enrich first, order scan inputs, and normalize the enrichment "hints" passed
 * through the sources endpoints. No server state or I/O lives here.
 */

import { cleanPromptText } from "./clean-prompt.js";
import {
  ENRICHMENT_SCORE_WEIGHTS,
  RECENT_SESSION_WINDOW_MS,
  SCAN_INPUT_SCORE_WEIGHTS,
} from "./constants.js";
import type { ScanInput, SessionScanResult } from "./scanner.js";
import type { SessionInfo } from "./types.js";

export interface EnrichmentHints {
  sessionIds?: string[];
  slugs?: string[];
  projects?: string[];
  limit?: number;
}

/**
 * The subset of a source-summary record this module reads. Declared locally
 * (rather than importing SourceSummaryRecord from server.ts) so this module has
 * no dependency — even a type-only one — pointing back at server.ts. The full
 * SourceSummaryRecord is structurally assignable to this, and the generic on
 * pickSourceRecordForSession preserves the caller's concrete record type. The
 * index signature mirrors SourceSummaryRecord's, so display-only fields like
 * `title`/`model`/`firstPrompt` are still readable as `unknown`.
 */
export interface EnrichmentSourceRecord {
  provider: string;
  slug: string;
  project: string;
  sessionId?: string;
  promptCount?: number;
  toolCallCount?: number;
  filePaths: string[];
  hasSqlite?: boolean;
  [key: string]: unknown;
}

export function sourceSessionKey(provider: string, project: string, slug: string): string {
  return `${provider}::${project}::${slug}`;
}

export function pickSourceRecordForSession<T extends EnrichmentSourceRecord>(
  session: Pick<SessionInfo, "provider" | "sessionId" | "project" | "slug">,
  bySessionId: Map<string, T>,
  byKey: Map<string, T>,
): T | undefined {
  const byIdMatch = bySessionId.get(session.sessionId);
  return (
    (byIdMatch?.provider === session.provider ? byIdMatch : undefined) ??
    byKey.get(sourceSessionKey(session.provider, session.project, session.slug))
  );
}

export function selectCursorEnrichmentCandidates(
  merged: SessionInfo[],
  baseSources: EnrichmentSourceRecord[],
  limitOrHints: number | EnrichmentHints = 30,
): SessionInfo[] {
  const hints = typeof limitOrHints === "number" ? { limit: limitOrHints } : limitOrHints;
  const limit = Math.max(1, Math.min(hints.limit ?? 30, 100));
  const preferredSessionIds = new Set(hints.sessionIds || []);
  const preferredSlugs = new Set(hints.slugs || []);
  const preferredProjects = new Set(hints.projects || []);
  const mergedBySessionId = new Map<string, SessionInfo>();
  const mergedByKey = new Map<string, SessionInfo>();
  for (const session of merged) {
    mergedBySessionId.set(session.sessionId, session);
    mergedByKey.set(sourceSessionKey(session.provider, session.project, session.slug), session);
  }

  return baseSources
    .filter(
      // A Cursor source needs enrichment if it has a usable source (SQLite or
      // files) AND *any* display field is missing or looks like raw noise.
      (s) =>
        s.provider === "cursor" &&
        (s.promptCount == null ||
          s.toolCallCount == null ||
          typeof s.title !== "string" ||
          !s.title.trim() ||
          typeof s.model !== "string" ||
          !s.model ||
          looksLikeCursorDisplayNoise(s.title) ||
          looksLikeCursorDisplayNoise(s.firstPrompt)) &&
        (s.hasSqlite || s.filePaths.length > 0),
    )
    .map((s) => {
      const byId = s.sessionId ? mergedBySessionId.get(s.sessionId) : undefined;
      return byId || mergedByKey.get(sourceSessionKey(s.provider, s.project, s.slug));
    })
    .filter((s): s is SessionInfo => Boolean(s))
    .sort((a, b) => {
      const scoreDelta =
        enrichmentPriorityScore(b, preferredSessionIds, preferredSlugs, preferredProjects) -
        enrichmentPriorityScore(a, preferredSessionIds, preferredSlugs, preferredProjects);
      return scoreDelta || b.timestamp.localeCompare(a.timestamp);
    })
    .slice(0, limit);
}

/** True when `timestamp` parses and is within RECENT_SESSION_WINDOW_MS of now. */
function isRecentActivity(timestamp: string | undefined): boolean {
  if (!timestamp) return false;
  return Date.now() - Date.parse(timestamp) <= RECENT_SESSION_WINDOW_MS;
}

/**
 * Score the preference/recency signals shared by both priority schemes.
 * Scheme-specific signals (hasPR, not-previously-scanned, etc.) are added by
 * the caller using its own weights.
 */
function preferenceScore(
  entity: { sessionId: string; slug: string; project: string; timestamp?: string },
  preferred: { sessionIds: Set<string>; slugs: Set<string>; projects: Set<string> },
  weights: {
    preferredSessionId: number;
    preferredSlug: number;
    preferredProject: number;
    recent: number;
  },
): number {
  let score = 0;
  if (preferred.sessionIds.has(entity.sessionId)) score += weights.preferredSessionId;
  if (preferred.slugs.has(entity.slug)) score += weights.preferredSlug;
  if (preferred.projects.has(entity.project)) score += weights.preferredProject;
  if (isRecentActivity(entity.timestamp)) score += weights.recent;
  return score;
}

function enrichmentPriorityScore(
  session: SessionInfo,
  preferredSessionIds: Set<string>,
  preferredSlugs: Set<string>,
  preferredProjects: Set<string>,
): number {
  let score = preferenceScore(
    session,
    { sessionIds: preferredSessionIds, slugs: preferredSlugs, projects: preferredProjects },
    ENRICHMENT_SCORE_WEIGHTS,
  );
  if (session.hasPR) score += ENRICHMENT_SCORE_WEIGHTS.hasPR;
  if (session.hasSqlite) score += ENRICHMENT_SCORE_WEIGHTS.hasSqlite;
  return score;
}

export function prioritizeScanInputs(
  inputs: ScanInput[],
  previousResults: Array<Pick<SessionScanResult, "sessionId">>,
  hints: EnrichmentHints = {},
): ScanInput[] {
  const previousSessionIds = new Set(previousResults.map((result) => result.sessionId));
  const preferredSessionIds = new Set(hints.sessionIds || []);
  const preferredSlugs = new Set(hints.slugs || []);
  const preferredProjects = new Set(hints.projects || []);

  return [...inputs].sort((a, b) => {
    const scoreDelta =
      scanInputPriorityScore(
        b,
        previousSessionIds,
        preferredSessionIds,
        preferredSlugs,
        preferredProjects,
      ) -
      scanInputPriorityScore(
        a,
        previousSessionIds,
        preferredSessionIds,
        preferredSlugs,
        preferredProjects,
      );
    return scoreDelta || (b.timestamp || "").localeCompare(a.timestamp || "");
  });
}

function scanInputPriorityScore(
  input: ScanInput,
  previousSessionIds: Set<string>,
  preferredSessionIds: Set<string>,
  preferredSlugs: Set<string>,
  preferredProjects: Set<string>,
): number {
  let score = preferenceScore(
    input,
    { sessionIds: preferredSessionIds, slugs: preferredSlugs, projects: preferredProjects },
    SCAN_INPUT_SCORE_WEIGHTS,
  );
  if (!previousSessionIds.has(input.sessionId))
    score += SCAN_INPUT_SCORE_WEIGHTS.notPreviouslyScanned;
  return score;
}

export function mergeEnrichmentHints(
  existing: EnrichmentHints | undefined,
  next: EnrichmentHints,
): EnrichmentHints {
  return {
    sessionIds: uniqueStrings([...(existing?.sessionIds || []), ...(next.sessionIds || [])]),
    slugs: uniqueStrings([...(existing?.slugs || []), ...(next.slugs || [])]),
    projects: uniqueStrings([...(existing?.projects || []), ...(next.projects || [])]),
    limit: Math.max(existing?.limit || 0, next.limit || 0) || undefined,
  };
}

function uniqueStrings(values: string[]): string[] {
  // Cap at 200 to bound hint accumulation: hints merge across repeated enrich
  // requests, so without a limit the deduped lists could grow unbounded.
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))].slice(
    0,
    200,
  );
}

export function enrichmentHintsFromBody(value: unknown): EnrichmentHints {
  if (!value || typeof value !== "object") return {};
  const body = value as Record<string, unknown>;
  return {
    sessionIds: stringArrayFromUnknown(body.sessionIds),
    slugs: stringArrayFromUnknown(body.slugs),
    projects: stringArrayFromUnknown(body.projects),
    limit: typeof body.limit === "number" ? body.limit : undefined,
  };
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return strings.length > 0 ? [...new Set(strings)] : undefined;
}

function looksLikeCursorDisplayNoise(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !cleanPromptText(value);
}
