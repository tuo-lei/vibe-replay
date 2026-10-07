import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const home = join(tmpdir(), `vibe-snapshot-offline-${Date.now()}`);
const discovery = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("Source storage unavailable");
  }),
);
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
vi.mock("../src/provider-discovery.js", () => ({ discoverProvidersSafely: discovery }));
vi.mock("../src/cache.js", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { loadCliSession } = await import("../src/session-workflows.js");
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("resolves an explicitly requested snapshot without touching unavailable source storage", async () => {
  const dir = join(home, ".vibe-replay", "offline-snapshot");
  await mkdir(dir, { recursive: true });
  const raw = JSON.stringify({
    meta: { sessionId: "offline-session", provider: "codex" },
    scenes: [{ type: "user-prompt", content: "Saved request" }],
  });
  await writeFile(join(dir, "replay.json"), raw);
  await writeFile(
    join(dir, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [{ sceneIndex: 0, modifiedValue: "Saved edit", updatedAt: "2026-10-06" }],
    }),
  );
  const loaded = await loadCliSession("offline-session", {
    provider: "codex",
    snapshot: true,
    readOnly: true,
  });
  expect(loaded.provenance).toMatchObject({ origin: "snapshot", sceneCount: 1 });
  expect(loaded.replay.scenes[0]).toEqual({ type: "user-prompt", content: "Saved edit" });
  expect(discovery).not.toHaveBeenCalled();
  await expect(
    loadCliSession("offline-session", { provider: "codex", source: true, readOnly: true }),
  ).rejects.toThrow("Source storage unavailable");
  expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(raw);
});

it("prefers exact saved IDs and slugs while rejecting ambiguous prefixes and exact collisions", async () => {
  const save = async (slug: string, sessionId: string) => {
    const dir = join(home, ".vibe-replay", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "replay.json"),
      JSON.stringify({
        meta: { sessionId, provider: "codex" },
        scenes: [{ type: "user-prompt", content: sessionId }],
      }),
    );
  };
  await save("exact-id-copy", "abcd");
  await save("abcd-more", "abcd-more-session");
  await save("exact-slug", "different-session");
  await save("exact-slug-more", "another-session");
  const options = { snapshot: true, readOnly: true };
  expect((await loadCliSession("abcd", options)).replay.meta.sessionId).toBe("abcd");
  expect((await loadCliSession("exact-slug", options)).replay.meta.sessionId).toBe(
    "different-session",
  );
  expect((await loadCliSession("abcd-more-s", options)).replay.meta.sessionId).toBe(
    "abcd-more-session",
  );
  await expect(loadCliSession("exact-sl", options)).rejects.toThrow(
    "Ambiguous saved replay reference",
  );
  await save("duplicate-exact-id", "abcd");
  await expect(loadCliSession("abcd", options)).rejects.toThrow("Ambiguous saved replay reference");
});
