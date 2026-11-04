import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSourceRoutes } from "../src/server-routes/sources.js";
import type {
  NormalizedSourceSessionCatalogCache,
  SourceSummaryRecord,
} from "../src/server-types.js";

vi.mock("../src/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/remote.js")>()),
  loadRemoteSourceConfigs: async () => [],
}));

let tempDir = "";
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function source(filePath: string, location?: SourceSummaryRecord["location"]): SourceSummaryRecord {
  return {
    provider: "codex",
    slug: "synthetic-session",
    sessionId: "synthetic-session-id",
    project: "/synthetic/project",
    timestamp: "2026-11-04T00:00:00.000Z",
    filePaths: [filePath],
    location,
  };
}

function appFor(record: SourceSummaryRecord) {
  const cache: NormalizedSourceSessionCatalogCache = { sessions: [record] };
  const app = new Hono();
  registerSourceRoutes(app, {
    baseDir: "/synthetic",
    cleanupPeriodDays: 30,
    readSourcesCatalogCache: async () => cache,
    writeDiscoveredSourcesCatalog: async () => ({
      schemaVersion: 1,
      discoveredAt: "2026-11-04T00:00:00.000Z",
      sessions: [record],
    }),
    getStaleSourceProviders: async () => [],
    discoverAllProviders: async () => ({ sessions: [], failedProviders: [], coverage: [] }),
    buildSourcesResult: async () => [record],
    normalizeSessionProjectsForHome: (sessions) => sessions,
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
  });
  return app;
}

function openUrl(record: SourceSummaryRecord, fileIndex = 0): string {
  const query = new URLSearchParams({
    provider: record.provider,
    slug: record.slug,
    project: record.project,
    fileIndex: String(fileIndex),
  });
  return `/api/sources/open?${query.toString()}`;
}

describe("catalogued JSONL source route", () => {
  it("opens a catalogued local JSONL file as safe inline text, repeatedly", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-source-file-"));
    const filePath = join(tempDir, "synthetic-session.jsonl");
    const contents = '{"type":"synthetic","message":"safe test content"}\n';
    await writeFile(filePath, contents, "utf8");
    const record = source(filePath, { kind: "local", id: "local", label: "Local" });
    const app = appFor(record);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(openUrl(record));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(await response.text()).toBe(contents);
    }
  });

  it("rejects files not uniquely present in the local catalog", async () => {
    const app = appFor(source("/synthetic/session.jsonl"));
    const response = await app.request(
      "/api/sources/open?provider=codex&slug=unknown&project=%2Fsynthetic%2Fproject&fileIndex=0&path=%2Fetc%2Fpasswd",
    );
    expect(response.status).toBe(404);
  });

  it("rejects SSH locations and non-JSONL catalog entries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-source-file-"));
    const txtPath = join(tempDir, "synthetic-session.txt");
    await writeFile(txtPath, "not JSONL", "utf8");
    const remoteRecord = source(txtPath, { kind: "ssh", id: "remote", label: "Remote" });
    expect((await appFor(remoteRecord).request(openUrl(remoteRecord))).status).toBe(404);

    const localRecord = source(txtPath, { kind: "local", id: "local", label: "Local" });
    expect((await appFor(localRecord).request(openUrl(localRecord))).status).toBe(404);
  });

  it("rejects a catalogued symlink even when it points to a JSONL file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-replay-source-file-"));
    const targetPath = join(tempDir, "target.jsonl");
    const linkPath = join(tempDir, "linked.jsonl");
    await writeFile(targetPath, '{"safe":true}\n', "utf8");
    await symlink(targetPath, linkPath);
    const record = source(linkPath, { kind: "local", id: "local", label: "Local" });

    const response = await appFor(record).request(openUrl(record));
    expect(response.status).toBe(404);
  });
});
