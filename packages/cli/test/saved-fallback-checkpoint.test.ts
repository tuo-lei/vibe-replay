import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const home = await mkdtemp(join(tmpdir(), "vibe-saved-checkpoint-"));
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
vi.mock("../src/provider-discovery.js", () => ({
  discoverProvidersSafely: async () => ({
    sessions: [],
    failedProviders: ["hermes"],
    coverage: [
      {
        provider: "hermes",
        status: "failed",
        sessionCount: 0,
        errorCode: "checkpoint-required",
        message: "Read-only discovery requires a checkpointed database.",
      },
    ],
  }),
}));
vi.mock("../src/cache.js", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { loadCliSession } = await import("../src/session-workflows.js");
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("tries saved ID/slug/prefix fallback before promoting an unrelated discovery checkpoint error", async () => {
  const dir = join(home, ".vibe-replay", "retained-copy");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "replay.json"),
    JSON.stringify({
      meta: { sessionId: "retained-session-full", provider: "cursor" },
      scenes: [{ type: "user-prompt", content: "Original" }],
    }),
  );
  await writeFile(
    join(dir, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [{ sceneIndex: 0, modifiedValue: "Edited snapshot", updatedAt: "2026-11-03" }],
    }),
  );
  for (const ref of ["retained-session-full", "retained-copy", "retained-session"])
    for (const preferReplay of [false, true]) {
      const loaded = await loadCliSession(ref, { readOnly: true, preferReplay });
      expect(loaded.provenance.origin).toBe("snapshot");
      expect(loaded.replay.scenes[0]).toEqual({ type: "user-prompt", content: "Edited snapshot" });
    }
  await expect(loadCliSession("missing", { readOnly: true })).rejects.toMatchObject({
    code: "checkpoint-required",
    suggestions: expect.arrayContaining([expect.stringContaining("replays --json")]),
  });
  await expect(
    loadCliSession("retained-session-full", { readOnly: true, source: true }),
  ).rejects.toMatchObject({ code: "checkpoint-required" });
  await writeFile(join(dir, "overlays.json"), "{");
  await expect(loadCliSession("retained-session-full", { readOnly: true })).rejects.toMatchObject({
    code: "invalid-sidecar",
  });
});
