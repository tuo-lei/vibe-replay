import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScanInput } from "../src/scanner.js";
import type { SourceSummaryRecord } from "../src/server.js";
import { __testables } from "../src/server.js";
import type { SessionInfo } from "../src/types.js";

const originalPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

afterEach(() => {
  if (originalPiSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalPiSessionDir;
  }
});

function makeCursorSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "cursor",
    sessionId: "cursor-session-a",
    slug: "aaaaaaaa",
    project: "~/project-a",
    cwd: "/tmp/project-a",
    version: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 10,
    fileSize: 1024,
    filePath: "/tmp/session-a.jsonl",
    filePaths: ["/tmp/session-a.jsonl"],
    toolPaths: ["/tmp/tool-a.txt"],
    firstPrompt: "test prompt",
    ...overrides,
  };
}

describe("sources enrichment helpers", () => {
  it("normalizes legacy and structured source-session catalog caches", () => {
    const legacy = __testables.normalizeSourceSessionCatalogCache({
      updatedAt: "2026-01-01T00:00:00.000Z",
      data: [
        {
          provider: "pi",
          slug: "pi-a",
          project: "~/project-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          filePaths: ["/tmp/pi-a.jsonl"],
        },
      ],
    });
    expect(legacy?.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(legacy?.legacy).toBe(true);
    expect(legacy?.sessions).toHaveLength(1);

    const structured = __testables.normalizeSourceSessionCatalogCache({
      updatedAt: "2026-01-01T00:10:00.000Z",
      data: {
        schemaVersion: 1,
        discoveredAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
        providerStates: {
          pi: { provider: "pi", discoveredAt: "2026-01-01T00:00:00.000Z", sessionCount: 1 },
        },
        sessions: legacy!.sessions,
      },
    });
    expect(structured?.cachedAt).toBe("2026-01-01T00:10:00.000Z");
    expect(structured?.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(structured?.legacy).toBe(false);
    expect(structured?.providerStates?.pi?.sessionCount).toBe(1);
  });

  it("preserves discoveredAt across non-discovery source catalog updates", () => {
    const updated = __testables.updateSourceSessionCatalogSessions(
      {
        sessions: [],
        cachedAt: "2026-01-01T00:00:00.000Z",
        discoveredAt: "2026-01-01T00:00:00.000Z",
        providerStates: {
          pi: { provider: "pi", discoveredAt: "2026-01-01T00:00:00.000Z", sessionCount: 1 },
        },
      },
      [
        {
          provider: "pi",
          slug: "pi-a",
          project: "~/project-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          filePaths: ["/tmp/pi-a.jsonl"],
          existingReplay: "pi-a",
        },
      ],
      "2026-01-01T00:10:00.000Z",
    );

    expect(updated.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:10:00.000Z");
    expect(updated.sessions[0]?.existingReplay).toBe("pi-a");
  });

  it("marks Pi source sessions stale when a JSONL mtime is newer than discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-pi-freshness-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const projectDir = join(root, "--tmp-project--");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, "2026-01-01T00-10-00-000Z_session.jsonl");
    await writeFile(sessionPath, "{}\n", "utf-8");
    const newer = new Date("2026-01-01T00:10:00.000Z");
    await utimes(sessionPath, newer, newer);

    await expect(
      __testables.getStaleSourceProviders({
        sessions: [],
        cachedAt: "2026-01-01T00:00:00.000Z",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual(["pi"]);

    await expect(
      __testables.getStaleSourceProviders({
        sessions: [],
        cachedAt: "2026-01-01T00:20:00.000Z",
        discoveredAt: "2026-01-01T00:20:00.000Z",
      }),
    ).resolves.toEqual([]);
  });

  it("does not mark Pi stale just because an active JSONL mtime advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-pi-active-freshness-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const projectDir = join(root, "--tmp-project--");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, "2026-01-01T00-00-00-000Z_session.jsonl");
    await writeFile(sessionPath, "{}\n", "utf-8");
    const discovered = new Date("2026-01-01T00:00:00.000Z");
    await utimes(sessionPath, discovered, discovered);
    const discoveredProbe = await __testables.probePiSourceFreshness();

    const newer = new Date("2026-01-01T00:10:00.000Z");
    await utimes(sessionPath, newer, newer);

    await expect(
      __testables.getStaleSourceProviders({
        sessions: [],
        cachedAt: "2026-01-01T00:00:00.000Z",
        discoveredAt: "2026-01-01T00:00:00.000Z",
        providerStates: {
          pi: {
            provider: "pi",
            discoveredAt: "2026-01-01T00:00:00.000Z",
            sessionCount: 1,
            newestSourceMtimeMs: discoveredProbe.newestSourceMtimeMs,
            newestSourcePath: discoveredProbe.newestSourcePath,
            fingerprint: __testables.sourceProviderFingerprint(discoveredProbe),
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not mark Pi stale when the sessions directory is missing", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = join(tmpdir(), "vr-missing-pi-sessions");
    await expect(
      __testables.getStaleSourceProviders({
        sessions: [],
        cachedAt: "2026-01-01T00:00:00.000Z",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual([]);
  });

  it("marks legacy source-session catalog caches stale when Pi files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-pi-legacy-freshness-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const projectDir = join(root, "--tmp-project--");
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, "2026-01-01T00-00-00-000Z_session.jsonl");
    await writeFile(sessionPath, "{}\n", "utf-8");
    const older = new Date("2026-01-01T00:00:00.000Z");
    await utimes(sessionPath, older, older);

    await expect(
      __testables.getStaleSourceProviders({
        sessions: [],
        cachedAt: "2026-01-01T01:00:00.000Z",
        discoveredAt: "2026-01-01T01:00:00.000Z",
        legacy: true,
      }),
    ).resolves.toEqual(["pi"]);
  });

  it("skips candidate sessions already enriched in cached sources", () => {
    const merged = [
      makeCursorSession({
        promptCount: undefined,
        toolCallCount: undefined,
      }),
    ];

    const baseSources: SourceSummaryRecord[] = [
      {
        provider: "cursor",
        sessionId: "cursor-session-a",
        slug: "aaaaaaaa",
        project: "~/project-a",
        timestamp: "2026-01-01T00:00:00.000Z",
        filePaths: ["/tmp/session-a.jsonl"],
        hasSqlite: true,
        promptCount: 12,
        toolCallCount: 8,
        title: "Clean session title",
        model: "claude-sonnet-4-20250514",
      },
    ];

    const candidates = __testables.selectCursorEnrichmentCandidates(merged, baseSources);
    expect(candidates).toHaveLength(0);
  });

  it("selects only missing-count cursor sessions and respects recency", () => {
    const merged = [
      makeCursorSession({
        sessionId: "cursor-old",
        slug: "oldold00",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-new",
        slug: "newnew00",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-done",
        slug: "done0000",
        timestamp: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const baseSources: SourceSummaryRecord[] = [
      {
        provider: "cursor",
        sessionId: "cursor-old",
        slug: "oldold00",
        project: "~/project-a",
        timestamp: "2026-01-01T00:00:00.000Z",
        filePaths: ["/tmp/session-old.jsonl"],
        promptCount: undefined,
        toolCallCount: undefined,
      },
      {
        provider: "cursor",
        sessionId: "cursor-new",
        slug: "newnew00",
        project: "~/project-a",
        timestamp: "2026-01-02T00:00:00.000Z",
        filePaths: ["/tmp/session-new.jsonl"],
        promptCount: undefined,
        toolCallCount: undefined,
      },
      {
        provider: "cursor",
        sessionId: "cursor-done",
        slug: "done0000",
        project: "~/project-a",
        timestamp: "2026-01-03T00:00:00.000Z",
        filePaths: ["/tmp/session-done.jsonl"],
        promptCount: 4,
        toolCallCount: 2,
        title: "Already enriched title",
        model: "claude-sonnet-4-20250514",
      },
    ];

    const candidates = __testables.selectCursorEnrichmentCandidates(merged, baseSources, 2);
    expect(candidates.map((s) => s.sessionId)).toEqual(["cursor-new", "cursor-old"]);
  });

  it("prioritizes hinted cursor sessions before default recency", () => {
    const merged = [
      makeCursorSession({
        sessionId: "cursor-old-visible",
        slug: "visible0",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-new",
        slug: "newnew00",
        timestamp: "2026-01-03T00:00:00.000Z",
      }),
      makeCursorSession({
        sessionId: "cursor-mid",
        slug: "midmid00",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
    ];

    const baseSources: SourceSummaryRecord[] = merged.map((source) => ({
      provider: "cursor",
      sessionId: source.sessionId,
      slug: source.slug,
      project: source.project,
      timestamp: source.timestamp,
      filePaths: source.filePaths,
      promptCount: undefined,
      toolCallCount: undefined,
    }));

    const candidates = __testables.selectCursorEnrichmentCandidates(merged, baseSources, {
      slugs: ["visible0"],
      limit: 2,
    });
    expect(candidates.map((s) => s.sessionId)).toEqual(["cursor-old-visible", "cursor-new"]);
  });

  it("prioritizes unscanned and hinted sessions during scan catch-up", () => {
    const inputs: ScanInput[] = [
      {
        sessionId: "already-new",
        provider: "cursor",
        project: "~/project-a",
        slug: "new",
        filePaths: ["/tmp/new.jsonl"],
        timestamp: "2026-01-03T00:00:00.000Z",
      },
      {
        sessionId: "unscanned-old",
        provider: "cursor",
        project: "~/project-a",
        slug: "old",
        filePaths: ["/tmp/old.jsonl"],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "hinted-mid",
        provider: "cursor",
        project: "~/project-a",
        slug: "mid",
        filePaths: ["/tmp/mid.jsonl"],
        timestamp: "2026-01-02T00:00:00.000Z",
      },
    ];

    const ordered = __testables.prioritizeScanInputs(
      inputs,
      [{ sessionId: "already-new" }, { sessionId: "hinted-mid" }] as any[],
      { slugs: ["mid"] },
    );

    expect(ordered.map((input) => input.sessionId)).toEqual([
      "hinted-mid",
      "unscanned-old",
      "already-new",
    ]);
  });

  it("does not cross-provider match by sessionId when picking cache records", () => {
    const current = makeCursorSession({ sessionId: "shared-id", slug: "aaaaaaaa" });
    const bySessionId = new Map<string, SourceSummaryRecord>([
      [
        "shared-id",
        {
          provider: "claude-code",
          sessionId: "shared-id",
          slug: "claude01",
          project: "~/project-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          filePaths: [],
          promptCount: 999,
          toolCallCount: 999,
        },
      ],
    ]);
    const byKey = new Map<string, SourceSummaryRecord>([
      [
        __testables.sourceSessionKey("cursor", "~/project-a", "aaaaaaaa"),
        {
          provider: "cursor",
          sessionId: "cursor-real",
          slug: "aaaaaaaa",
          project: "~/project-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          filePaths: [],
          promptCount: 5,
          toolCallCount: 3,
        },
      ],
    ]);

    const picked = __testables.pickSourceRecordForSession(current, bySessionId, byKey);
    expect(picked?.provider).toBe("cursor");
    expect(picked?.promptCount).toBe(5);
  });

  it("counts prompts/tools from parsed turns with compaction exclusion", () => {
    const counts = __testables.countSessionStats([
      {
        role: "user",
        subtype: "compaction-summary",
        blocks: [{ type: "text", text: "ignored" }],
      },
      {
        role: "user",
        blocks: [{ type: "_user_images", images: ["data:image/png;base64,abc"] }],
      },
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }, { type: "tool_use" }],
      },
    ] as any);

    expect(counts).toEqual({ promptCount: 1, toolCallCount: 2 });
  });

  it("preserves Cowork metadata in source API records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "vr-sources-result-"));
    const [source] = await __testables.buildSourcesResult(
      [
        makeCursorSession({
          provider: "claude-cowork",
          sessionId: "cowork-session-002",
          slug: "cowork-s",
          project: "Cowork",
          cwd: "/sessions/cowork/mnt/outputs",
          isStarred: true,
          pluginsEnabled: true,
          skillsEnabled: true,
          spaceId: "space_123456",
          spaceIdSetBy: "user",
          fsDetectedFiles: ["README.md", "src/index.ts"],
        }),
      ],
      baseDir,
      tmpdir(),
    );

    expect(source?.isStarred).toBe(true);
    expect(source?.pluginsEnabled).toBe(true);
    expect(source?.skillsEnabled).toBe(true);
    expect(source?.spaceId).toBe("space_123456");
    expect(source?.spaceIdSetBy).toBe("user");
    expect(source?.fsDetectedFiles).toEqual(["README.md", "src/index.ts"]);
  });
});
