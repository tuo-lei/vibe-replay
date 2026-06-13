/**
 * Shared numeric constants for the CLI.
 *
 * Centralizes "magic numbers" that previously lived inline across modules so
 * they are named, documented, and tunable in one place.
 */

/**
 * A session/scan input is considered "recent" (and gets a freshness boost in
 * priority scoring) if its last activity is within this window of now.
 */
export const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Weights for ranking which already-discovered Cursor sessions to enrich first.
 * Higher = enriched sooner. Applied in `enrichmentPriorityScore`.
 */
export const ENRICHMENT_SCORE_WEIGHTS = {
  /** Session was explicitly requested by id (e.g. the one the user is viewing). */
  preferredSessionId: 1000,
  /** Session matches a preferred slug. */
  preferredSlug: 800,
  /** Session belongs to a preferred project. */
  preferredProject: 400,
  /** Last activity within RECENT_SESSION_WINDOW_MS. */
  recent: 100,
  /** Session has an associated PR link. */
  hasPR: 25,
  /** Session has a Cursor SQLite source available. */
  hasSqlite: 10,
} as const;

/**
 * Weights for ordering scan inputs before a (potentially truncated) scan pass.
 * Distinct from ENRICHMENT_SCORE_WEIGHTS by design: this scheme prioritizes
 * not-yet-scanned inputs and weights explicit preferences far more heavily so
 * a user-requested session is scanned ahead of generic recent ones.
 */
export const SCAN_INPUT_SCORE_WEIGHTS = {
  /** Input has not been scanned in a previous pass. */
  notPreviouslyScanned: 1000,
  /** Input was explicitly requested by id. */
  preferredSessionId: 2000,
  /** Input matches a preferred slug. */
  preferredSlug: 1600,
  /** Input belongs to a preferred project. */
  preferredProject: 400,
  /** Last activity within RECENT_SESSION_WINDOW_MS. */
  recent: 100,
} as const;
