import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";

const state = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  writes: 0,
  rolloutReads: 0,
}));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async (key: string) =>
    state.store.has(key) ? { updatedAt: "", data: structuredClone(state.store.get(key)) } : null,
  writeFileCache: async (key: string, data: unknown) => {
    state.writes++;
    state.store.set(key, structuredClone(data));
  },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (path: string, options: Parameters<typeof actual.createReadStream>[1]) => {
      if (path.includes(`${join("sessions", "rollout-")}`)) state.rolloutReads++;
      return actual.createReadStream(path, options);
    },
  };
});
const { discoverCodexSessions } = await import("../src/codex/discover.js");

const CACHE_KEY = "codex-rollout-scan-v1";
const roots: string[] = [];

function rollout(id: string, prompts: string[]): string {
  return [
    JSON.stringify({ type: "session_meta", payload: { id, cwd: "/example/project" } }),
    ...prompts.map((text) =>
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: text },
      }),
    ),
  ].join("\n");
}

async function codexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-codex-cache-"));
  roots.push(root);
  await mkdir(join(root, "sessions"), { recursive: true });
  return root;
}

function cachedPaths(): string[] {
  return Object.keys((state.store.get(CACHE_KEY) ?? {}) as object).sort();
}

beforeEach(() => {
  state.store.clear();
  state.writes = 0;
  state.rolloutReads = 0;
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex discovery scan cache", () => {
  it("reuses unchanged rollouts across discoveries and rescans changed ones", async () => {
    const root = await codexHome();
    const first = join(root, "sessions", "rollout-a.jsonl");
    const second = join(root, "sessions", "rollout-b.jsonl");
    await writeFile(first, rollout("a", ["First prompt"]));
    await writeFile(second, rollout("b", ["Second prompt"]));

    const cold = await discoverCodexSessions(root, false, false);
    expect(state.rolloutReads).toBe(2);
    expect(state.writes).toBe(1);
    // A caller mutating the result must not change what later discoveries see.
    cold[0].title = "Mutated by caller";

    const warm = await discoverCodexSessions(root, false, false);
    expect(state.rolloutReads).toBe(2);
    expect(state.writes).toBe(1);
    expect(
      warm.map(({ sessionId, title, firstPrompt }) => ({ sessionId, title, firstPrompt })),
    ).toEqual(
      cold.map(({ sessionId, firstPrompt }) => ({ sessionId, title: undefined, firstPrompt })),
    );

    await appendFile(first, `\n${rollout("a", ["Later prompt"]).split("\n")[1]}`);
    const changed = await discoverCodexSessions(root, false, false);
    expect(state.rolloutReads).toBe(3);
    expect(changed.find((session) => session.sessionId === "a")?.promptCount).toBe(2);
  });

  it("does not write the cache inside a zero-write scope", async () => {
    const root = await codexHome();
    await writeFile(join(root, "sessions", "rollout-a.jsonl"), rollout("a", ["Prompt"]));
    await withReadOnlySqlite(true, () => discoverCodexSessions(root, false, false));
    expect(state.writes).toBe(0);
    expect(state.rolloutReads).toBe(1);
  });

  it("drops deleted rollouts under the scanned home and keeps other homes' entries", async () => {
    const local = await codexHome();
    const staged = await codexHome();
    const kept = join(staged, "sessions", "rollout-remote.jsonl");
    const removed = join(local, "sessions", "rollout-removed.jsonl");
    await writeFile(kept, rollout("remote", ["Remote prompt"]));
    await writeFile(removed, rollout("removed", ["Removed prompt"]));
    await writeFile(join(local, "sessions", "rollout-live.jsonl"), rollout("live", ["Live"]));
    await discoverCodexSessions(staged, false, false);
    await discoverCodexSessions(local, false, false);
    expect(cachedPaths()).toHaveLength(3);

    await rm(removed);
    await discoverCodexSessions(local, false, false);
    expect(cachedPaths()).toEqual([kept, join(local, "sessions", "rollout-live.jsonl")].sort());
  });
});
