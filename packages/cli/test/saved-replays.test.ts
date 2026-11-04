import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as providerDiscovery from "../src/provider-discovery.js";
import { querySavedReplays } from "../src/saved-replays.js";
import { contentRevision, loadCliSession } from "../src/session-workflows.js";

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "vibe-saved-list-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function save(base: string, slug: string, id: string, target?: string) {
  const dir = join(base, slug);
  await mkdir(dir);
  await writeFile(
    join(dir, "replay.json"),
    JSON.stringify({
      meta: {
        sessionId: id,
        provider: "cursor",
        project: "/example/project",
        cwd: "/example/project",
        title: "Saved replay",
        startTime: "2026-11-03T00:00:00Z",
        stats: { sceneCount: 2, userPrompts: 1, toolCalls: 0, thinkingBlocks: 0 },
        ...(target ? { location: { kind: "ssh", id: target, label: target } } : {}),
      },
      scenes: [
        { type: "user-prompt", content: "ORIGINAL_PRIVATE_CANARY" },
        { type: "text-response", content: "Response" },
      ],
    }),
  );
  return dir;
}

it("finds edited and annotated saved content with no provider storage and preserves bytes", async () => {
  const discover = vi
    .spyOn(providerDiscovery, "discoverProvidersSafely")
    .mockRejectedValue(new Error("Provider storage offline"));
  const base = await root();
  const dir = await save(base, "edited", "saved-session");
  await writeFile(
    join(dir, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [{ sceneIndex: 0, modifiedValue: "Details removed", updatedAt: "2026-11-03" }],
    }),
  );
  await writeFile(
    join(dir, "annotations.json"),
    JSON.stringify([{ id: "note", sceneIndex: 1, body: "Check this" }]),
  );
  const before = await readFile(join(dir, "replay.json"), "utf-8");
  const page = await querySavedReplays({ provider: "cursor", query: "removed" }, base);
  expect(discover).not.toHaveBeenCalled();
  expect(page.pagination).toMatchObject({ total: 1, returned: 1, truncated: false });
  expect(page.replays[0]).toMatchObject({
    sessionId: "saved-session",
    status: "ready",
    origin: "snapshot",
    annotationCount: 1,
    editedSceneCount: 1,
    firstPrompt: "Details removed",
    replayPath: join(dir, "replay.json"),
  });
  const loaded = await loadCliSession(page.replays[0].replayPath, {
    revision: page.replays[0].revision,
  });
  expect(page.replays[0].revision).toBe(contentRevision(loaded.replay));
  expect(JSON.stringify(page)).not.toContain("ORIGINAL_PRIVATE_CANARY");
  expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(before);
});

it("lists damaged edits safely without exposing original content or hiding healthy replays", async () => {
  const base = await root();
  const dir = await save(base, "broken", "broken-session");
  await writeFile(join(dir, "overlays.json"), "{");
  await save(base, "healthy", "healthy-session");
  await mkdir(join(base, "invalid"));
  await writeFile(join(base, "invalid", "replay.json"), "{original-sensitive-value");
  const page = await querySavedReplays({}, base);
  expect(page.partial).toBe(true);
  expect(page.replays).toHaveLength(2);
  const broken = page.replays.find((item) => item.sessionId === "broken-session")!;
  expect(broken).toMatchObject({ status: "invalid-sidecar", firstPrompt: "" });
  expect(broken.revision).toBeUndefined();
  expect(JSON.stringify(broken)).not.toContain("ORIGINAL_PRIVATE_CANARY");
  expect(JSON.stringify(page.issues)).not.toContain("original-sensitive-value");
  expect(page.issues).toEqual([
    { path: join(base, "invalid", "replay.json"), code: "unreadable-replay" },
  ]);
  await expect(loadCliSession(broken.replayPath)).rejects.toMatchObject({
    code: "invalid-sidecar",
  });
  expect(await readFile(join(dir, "overlays.json"), "utf-8")).toBe("{");
});

it("paginates stable snapshot identities, scopes duplicate IDs and rejects changed membership", async () => {
  const base = await root();
  await save(base, "local", "same-id");
  await save(base, "remote", "same-id", "remote-box");
  await save(base, "third", "third-id");
  const first = await querySavedReplays({ limit: 2 }, base);
  const last = await querySavedReplays(
    { limit: 2, offset: first.pagination.nextOffset, revision: first.pagination.revision },
    base,
  );
  expect(first.pagination).toMatchObject({ total: 3, returned: 2, truncated: true, nextOffset: 2 });
  expect(last.pagination).toMatchObject({ returned: 1, truncated: false });
  expect(new Set([...first.replays, ...last.replays].map((item) => item.replayPath)).size).toBe(3);
  await expect(querySavedReplays({ session: "same-id" }, base)).rejects.toThrow("Ambiguous");
  expect(
    (await querySavedReplays({ session: "same-id", target: "local" }, base)).replays[0].filePath,
  ).toBe(join(base, "local", "replay.json"));
  expect(
    (await querySavedReplays({ session: "same-id", target: "remote-box" }, base)).replays[0]
      .location?.kind,
  ).toBe("ssh");
  await save(base, "added", "added-id");
  await expect(
    querySavedReplays({ revision: first.pagination.revision }, base),
  ).rejects.toMatchObject({ code: "revision-mismatch" });
  expect((await querySavedReplays({}, join(base, "absent"))).pagination.total).toBe(0);
});
