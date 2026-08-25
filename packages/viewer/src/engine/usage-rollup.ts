import type { SessionLocation, SessionUsageSummary } from "@vibe-replay/types";
import { normalizeMcpServerName, normalizeMcpToolName } from "../components/dashboard-utils";

/** One scanned session's usage, as served by `/api/usage/rollup`. */
export interface UsageRollupSession {
  provider: string;
  sessionId: string;
  location?: SessionLocation;
  project?: string;
  startTime?: string;
  usage: SessionUsageSummary;
}

export interface UsageRollupEntry {
  name: string;
  /** Total invocations across the selected sessions. */
  calls: number;
  /** How many sessions used it at all — reach, as opposed to volume. */
  sessions: number;
}

export interface UsageRollup {
  tools: UsageRollupEntry[];
  mcpServers: UsageRollupEntry[];
  mcpTools: UsageRollupEntry[];
  skills: UsageRollupEntry[];
  /** Sessions that contributed at least one call to this rollup. */
  sessionCount: number;
  toolCalls: number;
  mcpCalls: number;
  successCount: number;
  errorCount: number;
}

interface Accumulator {
  calls: number;
  sessions: number;
}

function add(
  into: Map<string, Accumulator>,
  counts: Record<string, number>,
  normalizeName: (name: string) => string = (name) => name,
): void {
  const normalizedCounts = new Map<string, number>();
  for (const [name, calls] of Object.entries(counts)) {
    if (calls <= 0) continue;
    const normalizedName = normalizeName(name);
    normalizedCounts.set(normalizedName, (normalizedCounts.get(normalizedName) || 0) + calls);
  }
  for (const [normalizedName, calls] of normalizedCounts) {
    const entry = into.get(normalizedName);
    if (entry) {
      entry.calls += calls;
      entry.sessions += 1;
    } else {
      into.set(normalizedName, { calls, sessions: 1 });
    }
  }
}

function rank(counts: Map<string, Accumulator>, limit: number): UsageRollupEntry[] {
  return (
    [...counts.entries()]
      .map(([name, { calls, sessions }]) => ({ name, calls, sessions }))
      // Ties break alphabetically so the order is stable across re-renders.
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      .slice(0, limit)
  );
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export interface UsageRollupOptions {
  /** Keep only sessions that started at or after this ISO timestamp. */
  since?: string;
  limit?: number;
}

/**
 * Aggregate per-session usage counters into ranked cross-session lists.
 *
 * Sessions without a start time are kept in the all-time rollup but dropped by
 * any range filter — a rollup labelled "last 30 days" must not silently include
 * sessions whose date is unknown.
 */
export function rollupUsage(
  sessions: readonly UsageRollupSession[],
  { since, limit = 10 }: UsageRollupOptions = {},
): UsageRollup {
  // Compared as epoch ms rather than strings so a provider that reports a UTC
  // offset instead of `Z` still lands in the right range.
  const cutoffMs = since ? Date.parse(since) : Number.NaN;
  const tools = new Map<string, Accumulator>();
  const mcpServers = new Map<string, Accumulator>();
  const mcpTools = new Map<string, Accumulator>();
  const skills = new Map<string, Accumulator>();
  let sessionCount = 0;
  let toolCalls = 0;
  let mcpCalls = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const session of sessions) {
    if (!Number.isNaN(cutoffMs)) {
      const startedMs = session.startTime ? Date.parse(session.startTime) : Number.NaN;
      if (Number.isNaN(startedMs) || startedMs < cutoffMs) continue;
    }
    const usage = session.usage;
    const sessionToolCalls = sum(usage.tools);
    // Every MCP call increments exactly one server, so the server counts are the
    // MCP call total even when a call never named a tool.
    const sessionMcpCalls = sum(usage.mcpServers);
    if (sessionToolCalls === 0 && sessionMcpCalls === 0 && sum(usage.skills) === 0) continue;

    sessionCount += 1;
    toolCalls += sessionToolCalls;
    mcpCalls += sessionMcpCalls;
    successCount += usage.successCount;
    errorCount += usage.errorCount;
    add(tools, usage.tools);
    add(mcpServers, usage.mcpServers, normalizeMcpServerName);
    add(mcpTools, usage.mcpTools, normalizeMcpToolName);
    add(skills, usage.skills);
  }

  return {
    tools: rank(tools, limit),
    mcpServers: rank(mcpServers, limit),
    mcpTools: rank(mcpTools, limit),
    skills: rank(skills, limit),
    sessionCount,
    toolCalls,
    mcpCalls,
    successCount,
    errorCount,
  };
}
