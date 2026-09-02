import type { ReplaySummary } from "./server-types.js";
import type { SessionScanResult } from "./scanner.js";
import type { ProjectIdentity, SessionLocation, TurnMetric } from "@vibe-replay/types";

export interface InsightsRollupSession {
  project: string;
  projectIdentity?: ProjectIdentity;
  startTime?: string;
  durationMs?: number;
  cost?: number;
  prompts: number;
  edits: number;
  toolCalls: number;
  /** Included by the dashboard endpoint for range-scoped secondary charts. */
  provider?: string;
  location?: SessionLocation;
  model?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  turnDurations?: number[];
  turnMetrics?: TurnMetric[];
}

export interface InsightsRollupReplay {
  project: string;
  startTime?: string;
  location?: SessionLocation;
}

export interface InsightsRollupPayload {
  sessions: InsightsRollupSession[];
  replays: InsightsRollupReplay[];
}

/**
 * Project only the fields needed for exact time-range totals.
 * Deliberately omit tool arguments/results, titles, file paths, and usage
 * events: the Insights page only needs additive per-session metrics. The
 * dashboard requests the optional detail fields for range-scoped breakdowns.
 */
export function buildInsightsRollup(
  scans: readonly SessionScanResult[],
  replays: readonly ReplaySummary[],
  options: { includeDetails?: boolean } = {},
): InsightsRollupPayload {
  const includeDetails = options.includeDetails === true;
  return {
    sessions: scans.map((scan) => {
      const session: InsightsRollupSession = {
        project: scan.project,
        projectIdentity: scan.projectIdentity,
        startTime: scan.startTime,
        durationMs: scan.durationMs,
        cost: scan.costEstimate,
        prompts: scan.promptCount,
        edits: scan.editCount,
        toolCalls: scan.toolCallCount,
        location: scan.location,
      };
      if (includeDetails) {
        session.provider = scan.provider;
        session.model = scan.model;
        session.tokenUsage = scan.tokenUsage;
        session.turnDurations = scan.turnDurations;
        session.turnMetrics = scan.turnMetrics;
      }
      return session;
    }),
    replays: replays.map((replay) => ({
      project: replay.project,
      startTime: replay.startTime,
      location: replay.location,
    })),
  };
}
