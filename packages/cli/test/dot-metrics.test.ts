import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDotSessions, parseDotExport } from "@vibe-replay/provider-dot";
import { describe, expect, it, vi } from "vitest";
import { createLocalAssistantTools, type LocalAssistantData } from "../src/local-assistant.js";
import { scanSession, type SessionScanResult } from "../src/scanner.js";

async function insightsFor(scans: SessionScanResult[]) {
  const data: LocalAssistantData = {
    listSources: async () => [],
    listReplays: async () => [],
    getSession: async () => {
      throw new Error("Synthetic metrics fixture has no generated replay");
    },
    getScanResults: () => scans,
    getUserInsights: async () => null,
    getProjectInsights: async () => null,
  };
  const tools = createLocalAssistantTools(data, { mode: "dashboard" });
  const insights = tools.find((tool) => tool.name === "get_insights");
  expect(insights).toBeDefined();
  const result = await insights!.execute("dot-metrics", { scope: "user", range: "all" });
  return JSON.parse((result.content[0] as { text: string }).text);
}

function dotScan(): SessionScanResult {
  return {
    sessionId: "dot-synthetic-metrics",
    provider: "dot",
    project: "dot conversations",
    slug: "dot-synthetic-metrics",
    startTime: "2026-10-04T01:00:00.000Z",
    endTime: "2026-10-07T01:00:00.000Z",
    promptCount: 2,
    toolCallCount: 0,
    editCount: 0,
    filesModified: [],
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    usageIndexed: false,
  };
}

describe("dot execution metric availability", () => {
  it("rejects scanning a changed export under an earlier discovered snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dot-metrics-snapshot-"));
    vi.stubEnv("DOT_EXPORTS_DIR", directory);
    try {
      const path = join(directory, "synthetic.json");
      const exported = {
        before: [],
        message: {
          message_id: "synthetic-snapshot-message",
          channel: "chatgpt",
          author: "user",
          content: { text: "Synthetic original message." },
        },
        after: [],
        partial: false,
      };
      await writeFile(path, JSON.stringify(exported));
      const [discovered] = await discoverDotSessions();
      expect(discovered.sourceFingerprint).toBe(discovered.sessionId);
      const input = {
        provider: "dot",
        sessionId: discovered.sessionId,
        slug: discovered.slug,
        project: discovered.project,
        filePaths: discovered.filePaths,
        sourceFingerprint: discovered.sourceFingerprint,
      };
      expect((await scanSession(input)).firstPrompt).toBe("Synthetic original message.");

      exported.message.content.text = "Synthetic changed message.";
      await writeFile(path, JSON.stringify(exported));
      await expect(scanSession(input)).rejects.toThrow("changed since discovery");

      const [refreshed] = await discoverDotSessions();
      expect(refreshed.sessionId).not.toBe(discovered.sessionId);
      const scan = await scanSession({
        ...input,
        sessionId: refreshed.sessionId,
        slug: refreshed.slug,
        sourceFingerprint: refreshed.sourceFingerprint,
      });
      expect(scan.sessionId).toBe(refreshed.sessionId);
      expect(scan.firstPrompt).toBe("Synthetic changed message.");
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scans visible prompts without synthesizing per-turn execution metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dot-metrics-"));
    try {
      const path = join(directory, "synthetic.json");
      const message = (id: string, author: string, sentAt: string) => ({
        message_id: id,
        channel: "chatgpt",
        author,
        sent_at: sentAt,
        content: { text: `Synthetic visible message ${id}.` },
      });
      const exported = {
        before: [
          message("user-1", "user", "2026-10-04T01:00:00Z"),
          message("assistant-1", "aeon", "2026-10-05T01:00:00Z"),
          message("user-2", "user", "2026-10-06T01:00:00Z"),
        ],
        message: message("assistant-2", "aeon", "2026-10-07T01:00:00Z"),
        after: [],
        partial: false,
      };
      await writeFile(path, JSON.stringify(exported));
      const parsed = parseDotExport(exported);
      const scan = await scanSession({
        provider: "dot",
        sessionId: parsed.sessionId,
        slug: parsed.slug,
        project: "dot conversations",
        filePaths: [path],
      });
      expect(scan.promptCount).toBe(2);
      expect(scan.durationMs).toBeUndefined();
      expect(scan.turnMetrics).toBeUndefined();
      expect(scan.usageSummary).toBeUndefined();

      const payload = await insightsFor([scan]);
      expect(payload.totalSessions).toBe(1);
      expect(payload.totalPrompts).toBe(2);
      expect(Object.keys(payload.sessionMetricDistributions)).toEqual(["turns"]);
      expect(payload.sessionMetricDistributions.turns).toMatchObject({
        sampleCount: 1,
        percentiles: { p50: 2 },
      });
      expect(payload.perTurnDistributions).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores legacy zero-tool dot metrics without discarding native execution samples", async () => {
    const imported = { ...dotScan(), turnMetrics: [{ toolCalls: 0 }, { toolCalls: 0 }] };
    const native: SessionScanResult = {
      ...dotScan(),
      sessionId: "codex-synthetic-metrics",
      slug: "codex-synthetic-metrics",
      provider: "codex",
      project: "synthetic native project",
      promptCount: 1,
      toolCallCount: 4,
      durationMs: 60_000,
      turnMetrics: [{ toolCalls: 4, durationMs: 60_000, tokens: 100 }],
      tokenUsage: {
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };

    const dotOnly = await insightsFor([imported]);
    expect(Object.keys(dotOnly.sessionMetricDistributions)).toEqual(["turns"]);
    expect(dotOnly.perTurnDistributions).toBeUndefined();
    expect(dotOnly.totalPrompts).toBe(2);

    const mixed = await insightsFor([imported, native]);
    expect(mixed.totalPrompts).toBe(3);
    expect(mixed.sessionMetricDistributions.turns.sampleCount).toBe(2);
    for (const distributions of [mixed.sessionMetricDistributions, mixed.perTurnDistributions]) {
      expect(distributions.toolCalls).toMatchObject({
        sampleCount: 1,
        percentiles: { p25: 4, p50: 4, p75: 4, p95: 4, p99: 4 },
      });
      expect(distributions.durationMs).toMatchObject({
        sampleCount: 1,
        percentiles: { p50: 60_000 },
      });
      expect(distributions.tokens).toMatchObject({
        sampleCount: 1,
        percentiles: { p50: 100 },
      });
    }
  });
});
