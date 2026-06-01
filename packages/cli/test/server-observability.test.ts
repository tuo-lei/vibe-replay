import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testables } from "../src/server.js";

describe("server recoverable warnings", () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vr-server-observability-"));
    tempDirs.push(dir);
    return dir;
  }

  function makeReplayJson(slug: string): string {
    return JSON.stringify({
      meta: {
        sessionId: slug,
        slug,
        title: slug,
        provider: "claude-code",
        startTime: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/project",
        project: "/tmp/project",
        stats: {
          sceneCount: 0,
          userPrompts: 0,
          toolCalls: 0,
        },
      },
      scenes: [],
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("skips missing replay files without warning", async () => {
    const baseDir = await createTempDir();
    // Exercise the ENOENT suppression path with a non-replay subdirectory.
    await mkdir(join(baseDir, "cache"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a replay file exists but cannot be parsed", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "broken-session");
    await mkdir(replayDir, { recursive: true });
    await writeFile(join(replayDir, "replay.json"), "{", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Skipping unreadable replay");
    expect(warn.mock.calls[0]?.[0]).toContain("broken-session");
  });

  it("warns when a replay file has an invalid shape", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "invalid-shape-session");
    await mkdir(replayDir, { recursive: true });
    await writeFile(join(replayDir, "replay.json"), "{}", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Skipping unreadable replay");
    expect(warn.mock.calls[0]?.[0]).toContain("invalid-shape-session");
  });

  it("warns when scan-time annotation counts cannot be parsed", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "session-with-bad-annotation-count");
    await mkdir(replayDir, { recursive: true });
    await writeFile(
      join(replayDir, "replay.json"),
      makeReplayJson("session-with-bad-annotation-count"),
    );
    await writeFile(join(replayDir, "annotations.json"), "{", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.annotationCount).toBe(0);
    expect(sessions[0]?.hasAnnotations).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Unable to count annotations");
  });

  it("warns when scan-time annotation counts have the wrong shape", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "session-with-object-annotation-count");
    await mkdir(replayDir, { recursive: true });
    await writeFile(
      join(replayDir, "replay.json"),
      makeReplayJson("session-with-object-annotation-count"),
    );
    await writeFile(join(replayDir, "annotations.json"), "{}", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.annotationCount).toBe(0);
    expect(sessions[0]?.hasAnnotations).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("expected JSON array");
  });

  it("warns when annotations exist but cannot be parsed", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "session-with-bad-annotations");
    await mkdir(replayDir, { recursive: true });
    await writeFile(join(replayDir, "annotations.json"), "{", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const annotations = await __testables.loadAnnotations(baseDir, "session-with-bad-annotations");

    expect(annotations).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Unable to load annotations");
  });

  it("warns when annotations JSON has the wrong shape", async () => {
    const baseDir = await createTempDir();
    const replayDir = join(baseDir, "session-with-object-annotations");
    await mkdir(replayDir, { recursive: true });
    await writeFile(join(replayDir, "annotations.json"), "{}", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const annotations = await __testables.loadAnnotations(
      baseDir,
      "session-with-object-annotations",
    );

    expect(annotations).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("expected JSON array");
  });
});
