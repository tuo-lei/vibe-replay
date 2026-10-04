import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureLocalReplayHtml } from "../src/share.js";
import type { ReplaySession } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it.each(["[]", undefined])(
  "keeps local share content scoped to the explicit replay (annotations: %s)",
  async (annotations) => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-local-share-isolation-"));
    const unrelated = join(process.cwd(), "vibe-replay", basename(dir));
    roots.push(dir, unrelated);
    await mkdir(unrelated, { recursive: true });
    const original = JSON.stringify({
      meta: { sessionId: "local-share", provider: "codex" },
      scenes: [{ type: "user-prompt", content: "Selected session" }],
      annotations: [{ id: "deleted", sceneIndex: 0, body: "Deleted annotation" }],
    });
    await writeFile(join(dir, "replay.json"), original);
    if (annotations !== undefined) await writeFile(join(dir, "annotations.json"), annotations);
    await writeFile(
      join(unrelated, "annotations.json"),
      JSON.stringify([{ id: "unrelated", sceneIndex: 0, body: "Unrelated private annotation" }]),
    );
    await writeFile(
      join(unrelated, "overlays.json"),
      JSON.stringify({
        version: 1,
        overlays: [
          {
            sceneIndex: 0,
            modifiedValue: "Unrelated private content",
            updatedAt: "2026-10-04T00:00:00Z",
          },
        ],
      }),
    );
    const generate = vi.fn(async (_session: ReplaySession, outputDir: string) =>
      join(outputDir, "index.html"),
    );
    await ensureLocalReplayHtml(dir, generate);
    const shared = generate.mock.calls[0][0];
    expect(shared.scenes[0]).toEqual({ type: "user-prompt", content: "Selected session" });
    expect(shared.annotations).toEqual(
      annotations === "[]" ? [] : [{ id: "deleted", sceneIndex: 0, body: "Deleted annotation" }],
    );
    expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(original);
  },
);
