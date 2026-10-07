import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSourceRoutes } from "../src/server-routes/sources.js";
import type { SessionInfo } from "../src/types.js";
import type { SourceSummaryRecord } from "../src/server-types.js";

vi.mock("../src/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/remote.js")>()),
  loadRemoteSourceConfigs: async () => [],
}));
function session(index: number): SessionInfo {
  return {
    provider: index % 2 ? "claude-code" : "codex",
    sessionId: `session-${index}`,
    slug: `session-${index}`,
    project: "/tmp/project",
    cwd: "/tmp/project",
    version: "",
    timestamp: new Date(2026, 0, index + 1).toISOString(),
    lineCount: 1,
    fileSize: 10,
    filePath: `/tmp/${index}.jsonl`,
    filePaths: [`/tmp/${index}.jsonl`],
    firstPrompt: "A".repeat(500),
    title: "T".repeat(500),
  };
}
function setup(sessions: SessionInfo[], failedProviders: string[] = []) {
  const records: SourceSummaryRecord[] = sessions.map((entry) => ({
    ...entry,
    existingReplay: null,
  }));
  const write = vi.fn(async (sources: SourceSummaryRecord[]) => ({
    sessions: sources,
    discoveredAt: new Date().toISOString(),
  }));
  const deps: Parameters<typeof registerSourceRoutes>[1] = {
    baseDir: "/tmp",
    cleanupPeriodDays: 30,
    readSourcesCatalogCache: async () => null,
    writeDiscoveredSourcesCatalog: write,
    getStaleSourceProviders: async () => [],
    discoverAllProviders: async (subscriber) => {
      for (const entry of sessions) await subscriber?.(entry);
      return { sessions, failedProviders, coverage: [] };
    },
    buildSourcesResult: async (_merged, _baseDir, _home, _previous, _cleanup, progress) => {
      for (let i = 0; i < records.length; i++) await progress?.(records[i], i + 1, records.length);
      return records;
    },
    normalizeSessionProjectsForHome: (entries) => entries,
    enrichCursorStatsInBackground: vi.fn(),
    getSourcesEnrichmentStatus: () => ({ running: false, processed: 0, total: 0, updated: 0 }),
    getLastDiscoveredMergedSessions: () => [],
    setLastDiscoveredMergedSessions: vi.fn(),
    getLatestSourceFailures: () => [],
    setLatestSourceFailures: vi.fn(),
    getRemoteConfigChangedAt: () => undefined,
    setRemoteConfigChangedAt: vi.fn(),
    requestBackgroundScan: () => false,
    isSameOriginSettingsRequest: () => true,
  };
  const app = new Hono();
  registerSourceRoutes(app, deps);
  return { app, write };
}
function events(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}
describe("source discovery progress", () => {
  it.each([30, 500])("bounds previews and reports real totals for %i sessions", async (count) => {
    const sessions = Array.from({ length: count }, (_, i) => session(i));
    const { app, write } = setup(sessions);
    const response = await app.request("/api/sources/stream");
    const messages = events(await response.text());
    const progress = messages.filter((message) => message.type === "progress");
    expect(progress[0].phase).toBe("discovering");
    expect(progress[0].total).toBeUndefined();
    for (const message of progress) {
      expect(message.previews.length).toBeLessThanOrEqual(3);
      for (const preview of message.previews) {
        expect(preview.title.length).toBeLessThanOrEqual(160);
        expect(preview.firstPrompt.length).toBeLessThanOrEqual(160);
        expect(preview.filePaths).toBeUndefined();
      }
    }
    const prepared = progress.filter((message) => message.phase === "preparing");
    expect(prepared[0].total).toBe(count);
    expect(prepared[0].prepared).toBe(0);
    expect(prepared.at(-1).prepared).toBe(count);
    expect(prepared.at(-1).providers.sort()).toEqual(["claude-code", "codex"]);
    expect(prepared.at(-1).previews.map((preview: { slug: string }) => preview.slug)).toEqual(
      sessions
        .slice(-3)
        .toReversed()
        .map((entry) => entry.slug),
    );
    expect(messages.at(-1).sessions).toHaveLength(count);
    expect(write).toHaveBeenCalledOnce();
  });
  it("reports an empty catalog with failure coverage instead of invented sessions", async () => {
    const { app } = setup([], ["cursor"]);
    const response = await app.request("/api/sources/stream");
    const messages = events(await response.text());
    expect(messages[0]).toMatchObject({ phase: "preparing", prepared: 0, total: 0, previews: [] });
    expect(messages.at(-1)).toMatchObject({
      type: "complete",
      sessions: [],
      failedProviders: ["cursor"],
      stale: true,
    });
  });
});
