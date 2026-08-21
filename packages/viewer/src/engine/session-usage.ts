import type { SessionUsageSummary } from "@vibe-replay/types";

export interface UsageEntry {
  name: string;
  count: number;
}

export interface SessionUsageBreakdown {
  tools: UsageEntry[];
  mcpTools: UsageEntry[];
  skills: UsageEntry[];
  /** Distinct MCP servers, so the header can say "3 MCP servers" without listing them. */
  mcpServerCount: number;
  /** Tool calls plus MCP calls — the scan counters keep the two sets disjoint. */
  totalCalls: number;
  successCount: number;
  errorCount: number;
  /** Undefined when the provider recorded no per-call timings. */
  avgDurationMs?: number;
}

function rank(counts: Record<string, number>, limit: number): UsageEntry[] {
  return (
    Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      // Ties break alphabetically so the list is stable across re-renders.
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit)
  );
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/**
 * Turn a session's usage counters into the ranked lists the dashboard card
 * shows. Returns undefined when a session has no indexed usage at all, which is
 * the signal to render nothing rather than an empty breakdown.
 */
export function summarizeSessionUsage(
  summary: SessionUsageSummary | undefined,
  limit = 6,
): SessionUsageBreakdown | undefined {
  if (!summary) return undefined;
  // Every MCP call increments exactly one server, so the server counts are the
  // MCP call total without double-counting calls that never named a tool.
  const totalCalls = sum(summary.tools) + sum(summary.mcpServers);
  const skills = rank(summary.skills, limit);
  if (totalCalls === 0 && skills.length === 0) return undefined;

  return {
    tools: rank(summary.tools, limit),
    mcpTools: rank(summary.mcpTools, limit),
    skills,
    mcpServerCount: Object.keys(summary.mcpServers).length,
    totalCalls,
    successCount: summary.successCount,
    errorCount: summary.errorCount,
    avgDurationMs:
      summary.durationCount > 0
        ? Math.round(summary.totalDurationMs / summary.durationCount)
        : undefined,
  };
}
