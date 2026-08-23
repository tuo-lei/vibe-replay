import { rollupProject } from "../components/dashboard-utils";

export interface InsightsMetricSession {
  project: string;
  startTime?: string;
  durationMs?: number;
  cost?: number;
  prompts: number;
  edits: number;
  toolCalls: number;
}

export interface InsightsReplayRef {
  project: string;
  startTime?: string;
}

export interface InsightsRollupPayload {
  sessions: InsightsMetricSession[];
  replays: InsightsReplayRef[];
}

export interface InsightsRangeStats {
  sessions: number;
  replays: number;
  durationMs: number;
  cost: number;
  prompts: number;
  edits: number;
  toolCalls: number;
  projects: number;
}

export type InsightsRange = "7d" | "30d" | "90d" | "all";

export function rangeDays(range: InsightsRange): number {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return 0;
}

/**
 * Return the instant for the first local calendar day in a range.
 * A 7d range is today plus the six preceding local calendar days, including
 * the full local day even when the viewer's timezone is west of UTC or crosses
 * a daylight-saving transition.
 */
export function rangeSince(range: InsightsRange, now = new Date()): string | undefined {
  const days = rangeDays(range);
  if (days === 0) return undefined;
  const cutoff = new Date(now.getTime());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff.toISOString();
}

function isInRange(startTime: string | undefined, cutoffMs: number): boolean {
  if (Number.isNaN(cutoffMs)) return true;
  if (!Number.isFinite(cutoffMs)) return false;
  if (!startTime) return false;
  const startedMs = Date.parse(startTime);
  return Number.isFinite(startedMs) && startedMs >= cutoffMs;
}

/**
 * Aggregate exact per-session metrics for a selected time range.
 *
 * Unknown timestamps stay in all-time totals but are excluded from bounded
 * ranges so a value labelled "last 30 days" never includes undated history.
 */
export function rollupInsights(
  payload: InsightsRollupPayload,
  { since }: { since?: string } = {},
): InsightsRangeStats {
  const cutoffMs = since ? Date.parse(since) : Number.NaN;
  const sessions = payload.sessions.filter((session) => isInRange(session.startTime, cutoffMs));
  const replays = payload.replays.filter((replay) => isInRange(replay.startTime, cutoffMs));
  const projects = new Set<string>();
  let durationMs = 0;
  let cost = 0;
  let prompts = 0;
  let edits = 0;
  let toolCalls = 0;

  for (const session of sessions) {
    if (session.project) projects.add(rollupProject(session.project));
    durationMs += session.durationMs || 0;
    cost += session.cost || 0;
    prompts += session.prompts;
    edits += session.edits;
    toolCalls += session.toolCalls;
  }
  for (const replay of replays) {
    if (replay.project) projects.add(rollupProject(replay.project));
  }

  return {
    sessions: sessions.length,
    replays: replays.length,
    durationMs,
    cost,
    prompts,
    edits,
    toolCalls,
    projects: projects.size,
  };
}
