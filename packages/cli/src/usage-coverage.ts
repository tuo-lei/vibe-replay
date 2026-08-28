import {
  deriveTokenUsageMetrics,
  type MetricCoverage,
  type MetricQuality,
  type ProviderCoverage,
  type UsageCoverageReport,
} from "@vibe-replay/types";
import type { SessionScanResult } from "./scanner.js";

function sum(values: Record<string, number> | undefined): number {
  return Object.values(values || {}).reduce((total, value) => total + Math.max(0, value), 0);
}

function invocationCount(scan: SessionScanResult): number {
  if (!scan.usageSummary) return 0;
  return (
    sum(scan.usageSummary.tools) + sum(scan.usageSummary.mcpServers) + sum(scan.usageSummary.skills)
  );
}

function mcpCount(scan: SessionScanResult): number {
  return sum(scan.usageSummary?.mcpServers);
}

function mcpToolCount(scan: SessionScanResult): number {
  return sum(scan.usageSummary?.mcpTools);
}

function hasExpectedInvocationEvidence(scan: SessionScanResult): boolean {
  return (
    scan.toolCallCount > 0 ||
    (scan.mcpServersUsed?.length ?? 0) > 0 ||
    (scan.skillsUsed?.length ?? 0) > 0
  );
}

function qualityForIndexedMetric(
  provider: string,
  metric: "tokens" | "cache",
  totalSessions: number,
  availableSessions: number,
  hasDataLoss: boolean,
): MetricQuality {
  if (availableSessions === 0) return "unavailable";
  if (availableSessions < totalSessions || hasDataLoss) return "partial";
  // Cursor's tokenCount values are cumulative snapshots which can reset across
  // branches/resumes; its totals are useful but not billing-grade exact.
  if (provider === "cursor") return "estimated";
  return metric === "cache" ? "exact" : "exact";
}

function compactionQuality(
  provider: string,
  totalSessions: number,
  indexedSessions: number,
  compactionSessions: number,
  hasDataLoss: boolean,
): MetricQuality {
  if (totalSessions === 0) return "unavailable";
  // Cursor persists the latest conversation summary, not a durable event log.
  // A positive count is therefore a lower bound; zero is not proof of absence.
  if (provider === "cursor") return compactionSessions > 0 ? "partial" : "unavailable";
  if (indexedSessions < totalSessions || hasDataLoss) return "partial";
  return "exact";
}

function providerNotes(provider: string): string[] | undefined {
  if (provider === "cursor") {
    return [
      "Token/cache totals come from Cursor snapshots and are approximate.",
      "Compactions are lower bounds because Cursor persists the latest summary.",
    ];
  }
  if (provider === "codex") {
    return [
      "Input tokens are normalized to exclude cached_input_tokens.",
      "Codex currently reports cache reads but not cache writes.",
    ];
  }
  if (provider === "claude-cowork") {
    return ["Run-level result records are preferred over streaming usage snapshots."];
  }
  if (provider === "opencode") {
    return [
      "Usage is read from the provider SQLite message records; zero cache values mean none were recorded.",
    ];
  }
  if (provider === "hermes") {
    return [
      "Usage is read from the provider SQLite session/model records; zero cache values mean none were recorded.",
    ];
  }
  if (provider === "pi") {
    return [
      "Usage is read from the active JSONL branch; zero cache values mean none were recorded.",
    ];
  }
  if (provider === "claude-code" || provider === "claude-desktop") {
    return [
      "Usage is deduplicated by provider message ID; cache read/write fields are provider-reported.",
    ];
  }
  return undefined;
}

function coverage(
  availableSessions: number,
  totalSessions: number,
  quality: MetricQuality,
): MetricCoverage {
  return { availableSessions, totalSessions, quality };
}

function buildProviderCoverage(provider: string, scans: SessionScanResult[]): ProviderCoverage {
  const totalSessions = scans.length;
  const indexedSessions = scans.filter((scan) => scan.usageIndexed === true).length;
  const invocationSessions = scans.filter((scan) => invocationCount(scan) > 0).length;
  const invocationCalls = scans.reduce((total, scan) => total + invocationCount(scan), 0);
  const missingInvocationSessions = scans.filter(
    (scan) => scan.usageIndexed !== true && hasExpectedInvocationEvidence(scan),
  ).length;
  const mcpSessions = scans.filter(
    (scan) => mcpCount(scan) > 0 || (scan.mcpServersUsed?.length ?? 0) > 0,
  ).length;
  const mcpCalls = scans.reduce((total, scan) => total + mcpCount(scan), 0);
  const mcpToolSessions = scans.filter((scan) => mcpToolCount(scan) > 0).length;
  const mcpToolCalls = scans.reduce((total, scan) => total + mcpToolCount(scan), 0);
  const tokenSessions = scans.filter((scan) => scan.tokenUsage !== undefined).length;
  const inputTokens = scans.reduce((total, scan) => total + (scan.tokenUsage?.inputTokens || 0), 0);
  const outputTokens = scans.reduce(
    (total, scan) => total + (scan.tokenUsage?.outputTokens || 0),
    0,
  );
  const cacheReadTokens = scans.reduce(
    (total, scan) => total + (scan.tokenUsage?.cacheReadTokens || 0),
    0,
  );
  const cacheCreationTokens = scans.reduce(
    (total, scan) => total + (scan.tokenUsage?.cacheCreationTokens || 0),
    0,
  );
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const cacheMissTokens = inputTokens + cacheCreationTokens;
  const compactionSessions = scans.filter((scan) => scan.compactionCount > 0).length;
  const compactionCount = scans.reduce((total, scan) => total + scan.compactionCount, 0);
  const hasDataLoss = scans.some((scan) =>
    scan.dataQualityNotes?.some((note) =>
      /skipped|unparseable|malformed|partial .* scan/i.test(note),
    ),
  );
  const invocationQuality: MetricQuality =
    indexedSessions < totalSessions || missingInvocationSessions > 0 || hasDataLoss
      ? "partial"
      : "exact";

  return {
    provider,
    totalSessions,
    indexedSessions,
    invocationSessions,
    invocationCalls,
    missingInvocationSessions,
    mcpSessions,
    mcpCalls,
    mcpToolSessions,
    mcpToolCalls,
    tokenSessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokens,
    cacheMissTokens,
    compactionSessions,
    compactionCount,
    notes: providerNotes(provider),
    metrics: {
      invocations: coverage(indexedSessions, totalSessions, invocationQuality),
      mcpTools: coverage(
        mcpToolSessions,
        mcpSessions,
        mcpCalls === 0
          ? "unavailable"
          : mcpToolCalls < mcpCalls || hasDataLoss
            ? "partial"
            : "exact",
      ),
      tokens: coverage(
        tokenSessions,
        totalSessions,
        qualityForIndexedMetric(provider, "tokens", totalSessions, tokenSessions, hasDataLoss),
      ),
      cache: coverage(
        tokenSessions,
        totalSessions,
        qualityForIndexedMetric(provider, "cache", totalSessions, tokenSessions, hasDataLoss),
      ),
      compactions: coverage(
        provider === "cursor" ? compactionSessions : indexedSessions,
        totalSessions,
        compactionQuality(
          provider,
          totalSessions,
          indexedSessions,
          compactionSessions,
          hasDataLoss,
        ),
      ),
    },
  };
}

export function buildUsageCoverageReport(scans: readonly SessionScanResult[]): UsageCoverageReport {
  const grouped = new Map<string, SessionScanResult[]>();
  for (const scan of scans) {
    const group = grouped.get(scan.provider) || [];
    group.push(scan);
    grouped.set(scan.provider, group);
  }

  const providers = [...grouped.entries()]
    .map(([provider, providerScans]) => buildProviderCoverage(provider, providerScans))
    .sort((a, b) => b.totalSessions - a.totalSessions || a.provider.localeCompare(b.provider));

  const inputTokens = providers.reduce((total, provider) => total + provider.inputTokens, 0);
  const outputTokens = providers.reduce((total, provider) => total + provider.outputTokens, 0);
  const cacheReadTokens = providers.reduce(
    (total, provider) => total + provider.cacheReadTokens,
    0,
  );
  const cacheCreationTokens = providers.reduce(
    (total, provider) => total + provider.cacheCreationTokens,
    0,
  );
  const tokenMetrics = deriveTokenUsageMetrics({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });

  return {
    totalSessions: scans.length,
    indexedSessions: scans.filter((scan) => scan.usageIndexed === true).length,
    invocationSessions: providers.reduce(
      (total, provider) => total + provider.invocationSessions,
      0,
    ),
    invocationCalls: providers.reduce((total, provider) => total + provider.invocationCalls, 0),
    missingInvocationSessions: providers.reduce(
      (total, provider) => total + provider.missingInvocationSessions,
      0,
    ),
    mcpCalls: providers.reduce((total, provider) => total + provider.mcpCalls, 0),
    mcpToolSessions: providers.reduce((total, provider) => total + provider.mcpToolSessions, 0),
    mcpToolCalls: providers.reduce((total, provider) => total + provider.mcpToolCalls, 0),
    tokenSessions: scans.filter((scan) => scan.tokenUsage !== undefined).length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokens: tokenMetrics.promptTokens,
    cacheMissTokens: tokenMetrics.cacheMissTokens,
    compactionSessions: providers.reduce(
      (total, provider) => total + provider.compactionSessions,
      0,
    ),
    compactionCount: providers.reduce((total, provider) => total + provider.compactionCount, 0),
    providers,
  };
}
