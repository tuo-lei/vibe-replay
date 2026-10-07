import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ReplaySession } from "../src/types.js";

const home = join(tmpdir(), `vibe-share-revision-auth-${Date.now()}`);
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
const { saveAuthTokenSync } = await import("../src/publishers/cloud.js");
const { shareReplay } = await import("../src/share.js");
const roots: string[] = [home];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const session = {
  meta: {
    sessionId: "revision-share",
    provider: "codex",
    gitRepo: "private/repo",
    location: { kind: "ssh", id: "private-host" },
  },
  scenes: [{ type: "user-prompt", content: "Validated effective content" }],
  annotations: [{ id: "validated-note", sceneIndex: 0, body: "Validated note" }],
} as ReplaySession;
async function changedOutput() {
  const root = await mkdtemp(join(tmpdir(), "vibe-share-revision-"));
  roots.push(root);
  const raw = JSON.stringify({
    ...session,
    scenes: [{ type: "user-prompt", content: "Changed after resolution" }],
  });
  await writeFile(join(root, "replay.json"), raw);
  await writeFile(
    join(root, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [
        { sceneIndex: 0, modifiedValue: "Stale share directory edit", updatedAt: "2026-10-06" },
      ],
    }),
  );
  await writeFile(join(root, "annotations.json"), "[]");
  return { root, raw };
}

it("uploads the validated effective snapshot without rereading changed source or stale staging sidecars", async () => {
  const { root, raw } = await changedOutput();
  await mkdir(home, { recursive: true });
  roots.push(home);
  saveAuthTokenSync({ token: "mock-local-test", user: { id: "local", name: "Test" } });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "upload",
          url: "https://vibe-replay.com/r/upload",
          expiresAt: "2099-01-01",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await shareReplay(root, { loggedIn: true, session, visibility: "private" });
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const payload = JSON.parse(request[1].body as string);
  expect(payload.replay.scenes).toEqual(session.scenes);
  expect(payload.replay.annotations).toEqual(session.annotations);
  expect(payload.replay.meta.gitRepo).toBeUndefined();
  expect(payload.visibility).toBe("private");
  expect(await readFile(join(root, "replay.json"), "utf-8")).toBe(raw);
});

it("renders that same validated snapshot for local fallback and preserves current on-disk JSON", async () => {
  const { root, raw } = await changedOutput();
  const generated: ReplaySession[] = [];
  await shareReplay(root, {
    loggedIn: false,
    open: false,
    session,
    generateHtml: async (effective, outputDir) => {
      generated.push(effective);
      await writeFile(join(outputDir, "replay.json"), "temporary generated content");
      return join(outputDir, "index.html");
    },
  });
  expect(generated[0].scenes).toEqual(session.scenes);
  expect(generated[0].annotations).toEqual(session.annotations);
  expect(generated[0].meta.gitRepo).toBeUndefined();
  expect(await readFile(join(root, "replay.json"), "utf-8")).toBe(raw);
});
