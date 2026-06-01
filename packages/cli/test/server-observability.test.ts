import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testables } from "../src/server.js";

describe("server recoverable warnings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips missing replay files without warning", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "vr-server-observability-"));
    await mkdir(join(baseDir, "cache"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessions = await __testables.scanSessionsFromDir(baseDir);

    expect(sessions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a replay file exists but cannot be parsed", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "vr-server-observability-"));
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

  it("warns when annotations exist but cannot be parsed", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "vr-server-observability-"));
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
    const baseDir = await mkdtemp(join(tmpdir(), "vr-server-observability-"));
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
