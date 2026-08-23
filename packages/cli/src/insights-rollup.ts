import type { ReplaySummary } from "./server-types.js";
import type { SessionScanResult } from "./scanner.js";

export interface InsightsRollupSession {
  project: string;
  startTime?: string;
  durationMs?: number;
  cost?: number;
  prompts: number;
  edits: number;
  toolCalls: number;
}

export interface InsightsRollupReplay {
  project: string;
  startTime?: string;
}

export interface InsightsRollupPayload {
  sessions: InsightsRollupSession[];
  replays: InsightsRollupReplay[];
}

/**
 * Project only the fields needed for exact time-range totals.
 * Deliberately omit prompts, tool arguments/results, titles, file paths, and
 * usage events: the Insights page only needs additive per-session metrics.
 */
export function buildInsightsRollup(
  scans: readonly SessionScanResult[],
  replays: readonly ReplaySummary[],
): InsightsRollupPayload {
  return {
    sessions: scans.map((scan) => ({
      project: scan.project,
      startTime: scan.startTime,
      durationMs: scan.durationMs,
      cost: scan.costEstimate,
      prompts: scan.promptCount,
      edits: scan.editCount,
      toolCalls: scan.toolCallCount,
    })),
    replays: replays.map((replay) => ({
      project: replay.project,
      startTime: replay.startTime,
    })),
  };
}
