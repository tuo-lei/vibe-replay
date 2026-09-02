import { mergeProjectIdentities, projectIdentityKey } from "@vibe-replay/types";
import type { ProjectIdentity, SessionLocation, TurnMetric } from "@vibe-replay/types";

export interface InsightsMetricSession {
  project: string;
  projectIdentity?: ProjectIdentity;
  startTime?: string;
  durationMs?: number;
  cost?: number;
  prompts: number;
  edits: number;
  toolCalls: number;
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

export interface InsightsReplayRef {
  project: string;
  startTime?: string;
  location?: SessionLocation;
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

export interface InsightsRangeProject {
  project: string;
  projectIdentity?: ProjectIdentity;
  location?: SessionLocation;
  sessions: number;
  cost: number;
  prompts: number;
  durationMs: number;
  toolCalls: number;
  edits: number;
}

export interface InsightsRangeTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface InsightsRangeTurnDurationHistogram {
  buckets: Array<{ label: string; count: number; pct: number }>;
  percentiles: { p50Ms: number; p75Ms: number; p90Ms: number };
  totalTurns: number;
}

export interface SessionMetricDistribution {
  buckets: Array<{ label: string; count: number; pct: number }>;
  /** Linear-interpolated percentile cutoffs, in the metric's native unit. */
  percentiles: { p25: number; p50: number; p75: number; p95: number; p99: number };
  sampleCount: number;
}

export interface SessionMetricDistributions {
  /** Total active duration for each session, in milliseconds. */
  durationMs?: SessionMetricDistribution;
  /** All provider-recorded tool invocations for each session. */
  toolCalls?: SessionMetricDistribution;
  /** User prompts (turns) for each session. */
  turns?: SessionMetricDistribution;
  /** Input + output + cache read/write tokens for each session. */
  tokens?: SessionMetricDistribution;
}

export interface PerTurnDistributions {
  /** Active/provider-recorded time for each turn, in milliseconds. */
  durationMs?: SessionMetricDistribution;
  /** All recorded tool invocations attributed to each turn. */
  toolCalls?: SessionMetricDistribution;
  /** Input + output + cache read/write tokens for each turn. */
  tokens?: SessionMetricDistribution;
}

export interface InsightsRangeBreakdown {
  projects: InsightsRangeProject[];
  models: Record<string, number>;
  providers: Record<string, number>;
  tokenBreakdown?: InsightsRangeTokenBreakdown;
  turnDurationHistogram?: InsightsRangeTurnDurationHistogram;
  sessionMetricDistributions?: SessionMetricDistributions;
  perTurnDistributions?: PerTurnDistributions;
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

export function isInInsightsRange(startTime: string | undefined, since?: string): boolean {
  return isInRange(startTime, since ? Date.parse(since) : Number.NaN);
}

function sessionsInRange(payload: InsightsRollupPayload, since?: string): InsightsMetricSession[] {
  const cutoffMs = since ? Date.parse(since) : Number.NaN;
  return payload.sessions.filter((session) => isInRange(session.startTime, cutoffMs));
}

function scopedProjectKey(
  project: string,
  identity?: ProjectIdentity,
  location?: SessionLocation,
): string {
  const locationKey = location?.kind === "ssh" ? `ssh:${location.id}` : "local";
  return `${locationKey}\0${projectIdentityKey(project, identity)}`;
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
    if (session.project) {
      projects.add(scopedProjectKey(session.project, session.projectIdentity, session.location));
    }
    durationMs += session.durationMs || 0;
    cost += session.cost || 0;
    prompts += session.prompts;
    edits += session.edits;
    toolCalls += session.toolCalls;
  }
  for (const replay of replays) {
    if (replay.project) projects.add(scopedProjectKey(replay.project, undefined, replay.location));
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

const DURATION_BUCKETS: Array<{ label: string; minMs: number; maxMs: number }> = [
  { label: "<30s", minMs: 0, maxMs: 30_000 },
  { label: "30s-1m", minMs: 30_000, maxMs: 60_000 },
  { label: "1-2m", minMs: 60_000, maxMs: 120_000 },
  { label: "2-5m", minMs: 120_000, maxMs: 300_000 },
  { label: "5-10m", minMs: 300_000, maxMs: 600_000 },
  { label: "10m+", minMs: 600_000, maxMs: Number.POSITIVE_INFINITY },
];

function percentile(sorted: number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function buildTurnDurationHistogram(
  durations: readonly number[],
): InsightsRangeTurnDurationHistogram | undefined {
  const sorted = durations.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;

  const counts = DURATION_BUCKETS.map(() => 0);
  for (const duration of sorted) {
    const bucketIndex = DURATION_BUCKETS.findIndex((bucket) => duration < bucket.maxMs);
    if (bucketIndex >= 0) counts[bucketIndex]!++;
  }

  return {
    buckets: DURATION_BUCKETS.map((bucket, index) => ({
      label: bucket.label,
      count: counts[index]!,
      pct: Math.round((counts[index]! / sorted.length) * 1000) / 10,
    })),
    percentiles: {
      p50Ms: Math.round(percentile(sorted, 50)),
      p75Ms: Math.round(percentile(sorted, 75)),
      p90Ms: Math.round(percentile(sorted, 90)),
    },
    totalTurns: sorted.length,
  };
}

const SESSION_METRIC_BUCKETS = {
  durationMs: [
    { label: "<30s", max: 30_000 },
    { label: "30s-1m", max: 60_000 },
    { label: "1-2m", max: 120_000 },
    { label: "2-5m", max: 300_000 },
    { label: "5-10m", max: 600_000 },
    { label: "10m+", max: Number.POSITIVE_INFINITY },
  ],
  toolCalls: [
    { label: "0", max: 1 },
    { label: "1-5", max: 6 },
    { label: "6-10", max: 11 },
    { label: "11-25", max: 26 },
    { label: "26-50", max: 51 },
    { label: "51-100", max: 101 },
    { label: "100+", max: Number.POSITIVE_INFINITY },
  ],
  turns: [
    { label: "0", max: 1 },
    { label: "1-2", max: 3 },
    { label: "3-5", max: 6 },
    { label: "6-10", max: 11 },
    { label: "11-20", max: 21 },
    { label: "21-50", max: 51 },
    { label: "50+", max: Number.POSITIVE_INFINITY },
  ],
  tokens: [
    { label: "<1k", max: 1_000 },
    { label: "1-10k", max: 10_000 },
    { label: "10-50k", max: 50_000 },
    { label: "50-100k", max: 100_000 },
    { label: "100-250k", max: 250_000 },
    { label: "250-500k", max: 500_000 },
    { label: "500k+", max: Number.POSITIVE_INFINITY },
  ],
} as const;

type SessionMetricKey = keyof typeof SESSION_METRIC_BUCKETS;

const TURN_METRIC_BUCKETS = {
  durationMs: SESSION_METRIC_BUCKETS.durationMs,
  toolCalls: SESSION_METRIC_BUCKETS.toolCalls,
  tokens: SESSION_METRIC_BUCKETS.tokens,
} as const;

function buildSessionMetricDistribution(
  values: readonly number[],
  buckets: readonly { label: string; max: number }[],
): SessionMetricDistribution | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;

  const counts = buckets.map(() => 0);
  for (const value of sorted) {
    const bucketIndex = buckets.findIndex((bucket) => value < bucket.max);
    if (bucketIndex >= 0) counts[bucketIndex]!++;
  }

  return {
    buckets: buckets.map((bucket, index) => ({
      label: bucket.label,
      count: counts[index]!,
      pct: Math.round((counts[index]! / sorted.length) * 1000) / 10,
    })),
    percentiles: {
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    sampleCount: sorted.length,
  };
}

export function buildSessionMetricDistributions(
  sessions: readonly InsightsMetricSession[],
): SessionMetricDistributions | undefined {
  const values: Record<SessionMetricKey, number[]> = {
    durationMs: [],
    toolCalls: [],
    turns: [],
    tokens: [],
  };

  for (const session of sessions) {
    if (session.durationMs !== undefined) values.durationMs.push(session.durationMs);
    values.toolCalls.push(session.toolCalls);
    values.turns.push(session.prompts);
    if (session.tokenUsage) {
      values.tokens.push(
        session.tokenUsage.inputTokens +
          session.tokenUsage.outputTokens +
          session.tokenUsage.cacheReadTokens +
          session.tokenUsage.cacheCreationTokens,
      );
    }
  }

  const distributions: SessionMetricDistributions = {};
  for (const key of Object.keys(SESSION_METRIC_BUCKETS) as SessionMetricKey[]) {
    const distribution = buildSessionMetricDistribution(values[key], SESSION_METRIC_BUCKETS[key]);
    if (distribution) distributions[key] = distribution;
  }

  return Object.keys(distributions).length > 0 ? distributions : undefined;
}

type PerTurnMetricKey = keyof typeof TURN_METRIC_BUCKETS;

export function buildPerTurnDistributions(
  turnMetrics: readonly TurnMetric[],
): PerTurnDistributions | undefined {
  const values: Record<PerTurnMetricKey, number[]> = {
    durationMs: [],
    toolCalls: [],
    tokens: [],
  };

  for (const turn of turnMetrics) {
    if (turn.durationMs !== undefined) values.durationMs.push(turn.durationMs);
    values.toolCalls.push(turn.toolCalls);
    if (turn.tokens !== undefined) values.tokens.push(turn.tokens);
  }

  const distributions: PerTurnDistributions = {};
  for (const key of Object.keys(TURN_METRIC_BUCKETS) as PerTurnMetricKey[]) {
    const distribution = buildSessionMetricDistribution(values[key], TURN_METRIC_BUCKETS[key]);
    if (distribution) distributions[key] = distribution;
  }

  return Object.keys(distributions).length > 0 ? distributions : undefined;
}

/**
 * Aggregate the non-additive Insights sections for a selected time range.
 * These fields are carried per session by the optional detail projection so
 * changing the range does not require another request.
 */
export function rollupInsightsBreakdown(
  payload: InsightsRollupPayload,
  { since }: { since?: string } = {},
): InsightsRangeBreakdown {
  const sessions = sessionsInRange(payload, since);
  const projects = new Map<string, InsightsRangeProject>();
  const models: Record<string, number> = {};
  const providers: Record<string, number> = {};
  const durations: number[] = [];
  const turnMetrics: TurnMetric[] = [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;

  for (const session of sessions) {
    if (session.project) {
      const projectKey = scopedProjectKey(
        session.project,
        session.projectIdentity,
        session.location,
      );
      const project = projectIdentityKey(session.project, session.projectIdentity);
      const existing = projects.get(projectKey);
      if (existing) {
        existing.sessions++;
        existing.cost += session.cost || 0;
        existing.prompts += session.prompts;
        existing.durationMs += session.durationMs || 0;
        existing.toolCalls += session.toolCalls;
        existing.edits += session.edits;
        existing.projectIdentity = mergeProjectIdentities(
          existing.projectIdentity,
          session.projectIdentity,
        );
      } else {
        projects.set(projectKey, {
          project,
          projectIdentity: session.projectIdentity,
          ...(session.location ? { location: session.location } : {}),
          sessions: 1,
          cost: session.cost || 0,
          prompts: session.prompts,
          durationMs: session.durationMs || 0,
          toolCalls: session.toolCalls,
          edits: session.edits,
        });
      }
    }

    if (session.model) models[session.model] = (models[session.model] || 0) + 1;
    if (session.provider) providers[session.provider] = (providers[session.provider] || 0) + 1;

    if (session.tokenUsage) {
      input += session.tokenUsage.inputTokens;
      output += session.tokenUsage.outputTokens;
      cacheRead += session.tokenUsage.cacheReadTokens;
      cacheCreation += session.tokenUsage.cacheCreationTokens;
    }
    if (session.turnDurations) durations.push(...session.turnDurations);
    if (session.turnMetrics) turnMetrics.push(...session.turnMetrics);
  }

  const tokenTotal = input + output + cacheRead + cacheCreation;
  return {
    projects: [...projects.values()].sort(
      (a, b) =>
        b.sessions - a.sessions ||
        b.durationMs - a.durationMs ||
        a.project.localeCompare(b.project),
    ),
    models,
    providers,
    tokenBreakdown:
      tokenTotal > 0
        ? {
            input,
            output,
            cacheRead,
            cacheCreation,
          }
        : undefined,
    turnDurationHistogram: buildTurnDurationHistogram(durations),
    sessionMetricDistributions: buildSessionMetricDistributions(sessions),
    perTurnDistributions: buildPerTurnDistributions(turnMetrics),
  };
}
