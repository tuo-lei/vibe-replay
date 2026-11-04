import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as workflows from "../src/session-workflows.js";
import { querySavedReplays } from "../src/saved-replays.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function corpus(count: number) {
  const root = await mkdtemp(join(tmpdir(), "vibe-saved-bounds-"));
  roots.push(root);
  for (let i = 0; i < count; i++) {
    const dir = join(root, `saved-${i}`);
    await mkdir(dir);
    await writeFile(
      join(dir, "replay.json"),
      JSON.stringify({
        meta: { sessionId: `session-${i}`, provider: "cursor", startTime: "2026-11-03T00:00:00Z" },
        scenes: [{ type: "user-prompt", content: "Saved request" }],
      }),
    );
  }
  return root;
}

it("bounds snapshot readers and computes full content revisions only for the returned page", async () => {
  const base = await corpus(20);
  const original = workflows.readSavedReplay;
  let active = 0;
  let peak = 0;
  const read = vi.spyOn(workflows, "readSavedReplay").mockImplementation(async (directory) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await setTimeout(5);
      return await original(directory);
    } finally {
      active--;
    }
  });
  const revision = vi.spyOn(workflows, "contentRevision");
  const page = await querySavedReplays({ limit: 1 }, base);
  expect(page.pagination).toMatchObject({ total: 20, returned: 1 });
  expect(peak).toBeLessThanOrEqual(4);
  expect(read).toHaveBeenCalledTimes(21);
  expect(revision).toHaveBeenCalledTimes(1);
  expect(page.replays[0].revision).toMatch(/^[a-f0-9]{64}$/);
});

it("rejects edits changed between catalog projection and loading the selected revision", async () => {
  const base = await corpus(1);
  const original = workflows.readSavedReplay;
  let reads = 0;
  vi.spyOn(workflows, "readSavedReplay").mockImplementation(async (directory) => {
    const value = await original(directory);
    if (++reads === 2)
      await writeFile(
        join(directory, "overlays.json"),
        JSON.stringify({
          version: 1,
          overlays: [
            { sceneIndex: 0, modifiedValue: "Changed while listing", updatedAt: "2026-11-04" },
          ],
        }),
      );
    return value;
  });
  await expect(querySavedReplays({}, base)).rejects.toMatchObject({ code: "revision-mismatch" });
});
