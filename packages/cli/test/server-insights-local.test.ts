import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/insights.js", () => ({
  readInsightsStore: async () => ({
    schemaVersion: 1,
    lastUpdated: "2026-10-24T00:00:00.000Z",
    sessions: [
      {
        sessionId: "session-a",
        provider: "codex",
        usageSummary: { tools: { Read: 1 } },
        usageEvents: [{ kind: "tool", name: "Read", status: "success" }],
      },
    ],
  }),
}));
const { registerInsightsRoutes } = await import("../src/server-routes/insights.js");

describe("GET /api/insights/local", () => {
  it("returns durable records without per-session detail events", async () => {
    const app = new Hono();
    registerInsightsRoutes(app, {
      getScanState: () => ({ results: [] }) as never,
      getInsightsCache: () => ({ userInsights: null, projectInsights: new Map() }),
      requestBackgroundScan: () => false,
      refreshReplaysCache: async () => null,
      readCachedReplays: async () => [],
      syncInsightsToCloud: async () => ({ synced: 0, total: 0 }),
    });

    const body = await (await app.request("/api/insights/local")).json();

    expect(body.sessions).toEqual([
      { sessionId: "session-a", provider: "codex", usageSummary: { tools: { Read: 1 } } },
    ]);
    expect(body.lastUpdated).toBe("2026-10-24T00:00:00.000Z");
  });
});
