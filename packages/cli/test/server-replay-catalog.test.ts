import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionFromDisk, resolveReplayDir } from "../src/server-replay-catalog.js";

const originalCwd = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("replay catalog fallback locations", () => {
  it("resolves and loads legacy CWD replays when the primary directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-server-replay-catalog-"));
    roots.push(root);
    process.chdir(root);

    const baseDir = join(root, "primary");
    const replayDir = join(root, "vibe-replay", "legacy-session");
    await mkdir(replayDir, { recursive: true });
    await writeFile(
      join(replayDir, "replay.json"),
      JSON.stringify({
        schemaVersion: 1,
        meta: {
          sessionId: "legacy-session-id",
          slug: "legacy-session",
          provider: "cursor",
        },
        scenes: [],
      }),
      "utf-8",
    );

    await expect(resolveReplayDir(baseDir, "legacy-session")).resolves.toBe(
      resolve(process.cwd(), "vibe-replay", "legacy-session"),
    );
    await expect(loadSessionFromDisk(baseDir, "legacy-session")).resolves.toMatchObject({
      meta: { sessionId: "legacy-session-id" },
      scenes: [],
    });
  });
});
