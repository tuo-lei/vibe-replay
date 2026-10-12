import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";

// In-memory stand-in for the on-disk cache so the tests can inspect and tamper with it.
const cache = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  writes: 0,
}));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async (key: string) =>
    cache.store.has(key)
      ? { updatedAt: new Date().toISOString(), data: cache.store.get(key) }
      : null,
  writeFileCache: async (key: string, data: unknown) => {
    cache.writes++;
    cache.store.set(key, structuredClone(data));
  },
}));
const { discoverPiSessions } = await import("../src/pi/discover.js");

const CACHE_KEY = "pi-session-scan-v1";
const tempDirs: string[] = [];

interface CacheRows {
  [path: string]: { size: number; mtimeMs: number; scan: { promptCount: number } };
}

function cacheRows(): CacheRows {
  return (cache.store.get(CACHE_KEY) ?? {}) as CacheRows;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sessionLines(id: string, prompts: string[]): string {
  return (
    line({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/Users/test/project",
    }) +
    prompts
      .map((text, index) =>
        line({
          type: "message",
          timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
          message: { role: "user", content: [{ type: "text", text }] },
        }),
      )
      .join("")
  );
}

async function makeRoot(): Promise<{ root: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "vibe-pi-cache-"));
  tempDirs.push(root);
  const projectDir = join(root, "--Users-test-project--");
  await mkdir(projectDir, { recursive: true });
  return { root, projectDir };
}

beforeEach(() => {
  cache.store.clear();
  cache.writes = 0;
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Pi discovery scan cache", () => {
  it("persists one entry per transcript and returns identical sessions when warm", async () => {
    const { root, projectDir } = await makeRoot();
    const a = join(projectDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    const b = join(projectDir, "2026-01-02T00-00-00-000Z_b.jsonl");
    await writeFile(a, sessionLines("session-a", ["first", "second"]), "utf-8");
    await writeFile(b, sessionLines("session-b", ["only"]), "utf-8");

    const cold = await discoverPiSessions(root, false);
    expect(cold).toHaveLength(2);
    expect(Object.keys(cacheRows()).sort()).toEqual([a, b]);
    expect(cache.writes).toBe(1);

    const warm = await discoverPiSessions(root, false);
    expect(warm).toEqual(cold);
    expect(cache.writes).toBe(1);
  });

  it("serves cached scan results until the transcript's size or mtime changes", async () => {
    const { root, projectDir } = await makeRoot();
    const path = join(projectDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    await writeFile(path, sessionLines("session-a", ["first"]), "utf-8");
    await discoverPiSessions(root, false);

    // A tampered row proves the warm run reads the cache instead of re-scanning the file.
    cacheRows()[path].scan.promptCount = 42;
    const tampered = await discoverPiSessions(root, false);
    expect(tampered[0].promptCount).toBe(42);

    await appendFile(
      path,
      line({
        type: "message",
        timestamp: "2026-01-01T00:00:09.000Z",
        message: { role: "user", content: [{ type: "text", text: "appended" }] },
      }),
      "utf-8",
    );
    const rescanned = await discoverPiSessions(root, false);
    expect(rescanned[0].promptCount).toBe(2);
    expect(cacheRows()[path].scan.promptCount).toBe(2);

    // Same size, newer mtime is also a miss.
    cacheRows()[path].scan.promptCount = 42;
    const bumped = new Date(Date.now() + 60_000);
    await utimes(path, bumped, bumped);
    const afterTouch = await discoverPiSessions(root, false);
    expect(afterTouch[0].promptCount).toBe(2);
  });

  it("applies discovery options on top of one cached scan", async () => {
    const { root, projectDir } = await makeRoot();
    await writeFile(
      join(projectDir, "2026-01-01T00-00-00-000Z_empty.jsonl"),
      sessionLines("empty-session", []),
      "utf-8",
    );

    expect(await discoverPiSessions(root, false)).toHaveLength(0);
    const retained = await discoverPiSessions(root, false, true);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      sessionId: "empty-session",
      transcriptStatus: "no-prompts",
    });
    expect(cache.writes).toBe(1);
  });

  it("never persists a transcript that could not be read", async () => {
    const { root, projectDir } = await makeRoot();
    // A directory with a .jsonl name stats fine but fails to stream.
    await mkdir(join(projectDir, "2026-01-01T00-00-00-000Z_broken.jsonl"));
    await writeFile(
      join(projectDir, "2026-01-02T00-00-00-000Z_ok.jsonl"),
      sessionLines("ok-session", ["hello"]),
      "utf-8",
    );

    const sessions = await discoverPiSessions(root, false, true);
    const broken = sessions.find((session) => session.filePath.endsWith("broken.jsonl"));
    expect(broken).toMatchObject({ transcriptStatus: "unreadable", promptCount: 0 });
    expect(Object.keys(cacheRows())).toHaveLength(1);
    expect(Object.keys(cacheRows())[0]).toMatch(/ok\.jsonl$/);
  });

  it("drops entries for deleted transcripts", async () => {
    const { root, projectDir } = await makeRoot();
    const keep = join(projectDir, "2026-01-01T00-00-00-000Z_keep.jsonl");
    const gone = join(projectDir, "2026-01-02T00-00-00-000Z_gone.jsonl");
    await writeFile(keep, sessionLines("keep", ["a"]), "utf-8");
    await writeFile(gone, sessionLines("gone", ["b"]), "utf-8");
    await discoverPiSessions(root, false);
    expect(Object.keys(cacheRows())).toHaveLength(2);

    await rm(gone);
    const sessions = await discoverPiSessions(root, false);
    expect(sessions.map((session) => session.sessionId)).toEqual(["keep"]);
    expect(Object.keys(cacheRows())).toEqual([keep]);
    expect(cache.writes).toBe(2);
  });

  it("keeps entries for other roots whose transcripts still exist", async () => {
    const first = await makeRoot();
    const second = await makeRoot();
    const firstPath = join(first.projectDir, "2026-01-01T00-00-00-000Z_one.jsonl");
    const secondPath = join(second.projectDir, "2026-01-01T00-00-00-000Z_two.jsonl");
    await writeFile(firstPath, sessionLines("one", ["a"]), "utf-8");
    await writeFile(secondPath, sessionLines("two", ["b"]), "utf-8");

    await discoverPiSessions(first.root, false);
    await discoverPiSessions(second.root, false);
    expect(Object.keys(cacheRows()).sort()).toEqual([firstPath, secondPath].sort());
  });

  it("keeps every root's fresh entries when roots are scanned concurrently", async () => {
    const roots = await Promise.all([makeRoot(), makeRoot(), makeRoot()]);
    const paths: string[] = [];
    for (const [index, { projectDir }] of roots.entries()) {
      const path = join(projectDir, `2026-01-0${index + 1}T00-00-00-000Z_s.jsonl`);
      await writeFile(path, sessionLines(`session-${index}`, ["hello"]), "utf-8");
      paths.push(path);
    }

    // Local and SSH discovery run in parallel, so cold roots race on the shared cache file.
    await Promise.all(roots.map(({ root }) => discoverPiSessions(root, false)));
    expect(Object.keys(cacheRows()).sort()).toEqual([...paths].sort());

    const writesAfterCold = cache.writes;
    await Promise.all(roots.map(({ root }) => discoverPiSessions(root, false)));
    expect(cache.writes).toBe(writesAfterCold);
  });

  it("does not write the cache inside a read-only scope", async () => {
    const { root, projectDir } = await makeRoot();
    await writeFile(
      join(projectDir, "2026-01-01T00-00-00-000Z_a.jsonl"),
      sessionLines("session-a", ["first"]),
      "utf-8",
    );

    const sessions = await withReadOnlySqlite(true, () => discoverPiSessions(root, false));
    expect(sessions).toHaveLength(1);
    expect(cache.writes).toBe(0);
    expect(cache.store.has(CACHE_KEY)).toBe(false);
  });
});
