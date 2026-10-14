import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";

const home = join(tmpdir(), `vibe-cursor-sdk-index-${Date.now()}`);
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));

// In-memory stand-in for the on-disk cache so the test can inspect and tamper with it.
const cache = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  writes: 0,
}));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async (key: string) =>
    cache.store.has(key)
      ? { updatedAt: new Date().toISOString(), data: cache.store.get(key) }
      : null,
  writeFileCache: async (key: string, data: unknown) => {
    cache.writes++;
    cache.store.set(key, data);
  },
}));
const { discoverSdkAgents, __testables } = await import("../src/cursor/sdk-reader.js");

const CACHE_KEY = "cursor-sdk-agent-index-v1";
const projectsRoot = join(home, ".cursor", "projects");
const dbPaths = [
  join(projectsRoot, "alpha", "sdk-agent-store", "hash-a", "index.db"),
  join(projectsRoot, "beta", "sdk-agent-store", "hash-b", "index.db"),
];

async function writeIndexDb(path: string, agents: Array<{ id: string; name: string }>) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(
      "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT, status TEXT, name TEXT, created_at TEXT, updated_at TEXT);" +
        // Pad past the reader's minimum size so the file is treated as a real index.
        "CREATE TABLE pad (v TEXT);",
    );
    for (const agent of agents) {
      db.run("INSERT INTO agents VALUES (?, ?, 'COMPLETED', ?, '', '')", [
        agent.id,
        "/work/space",
        agent.name,
      ]);
    }
    for (let i = 0; i < 64; i++) db.run("INSERT INTO pad VALUES (?)", ["x".repeat(200)]);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, db.export());
  } finally {
    db.close();
  }
}

/**
 * `discoverSdkAgents` keeps a 60s in-process index. The fake clock only ever moves
 * forward, so a timestamp left behind by an earlier test can never look recent.
 */
let clock = Date.now();
function expireInProcessIndex() {
  clock += 5 * 60_000;
  vi.setSystemTime(clock);
}

beforeAll(async () => {
  await writeIndexDb(dbPaths[0], [{ id: "agent-1", name: "first" }]);
  await writeIndexDb(dbPaths[1], [{ id: "agent-2", name: "second" }]);
});
beforeEach(() => {
  cache.store.clear();
  cache.writes = 0;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  expireInProcessIndex();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const names = async () =>
  Object.fromEntries((await discoverSdkAgents()).map((agent) => [agent.agentId, agent.name]));

it("persists one entry per index database after the first scan", async () => {
  expect(await names()).toEqual({ "agent-1": "first", "agent-2": "second" });
  expect(Object.keys(cache.store.get(CACHE_KEY) as object).sort()).toEqual([...dbPaths].sort());
  expect(cache.writes).toBe(1);
});

it("reuses persisted rows while the database fingerprint is unchanged, and re-reads once it changes", async () => {
  await names();
  const persisted = cache.store.get(CACHE_KEY) as Record<
    string,
    { agents: Array<{ name: string }> }
  >;
  persisted[dbPaths[0]].agents[0].name = "served-from-cache";

  expireInProcessIndex();
  expect(await names()).toEqual({ "agent-1": "served-from-cache", "agent-2": "second" });
  expect(cache.writes).toBe(1); // nothing was re-read, so nothing is rewritten

  const future = new Date(clock + 60_000);
  await utimes(dbPaths[0], future, future);
  expireInProcessIndex();
  expect(await names()).toEqual({ "agent-1": "first", "agent-2": "second" });
  expect(cache.writes).toBe(2);
});

it("lets a later database win a duplicate agent id, exactly like a serial scan", async () => {
  const ordered = await __testables.listSdkIndexDbPaths(projectsRoot);
  const duplicateId = "agent-dup";
  await writeIndexDb(dbPaths[0], [{ id: duplicateId, name: "from-alpha" }]);
  await writeIndexDb(dbPaths[1], [{ id: duplicateId, name: "from-beta" }]);
  try {
    const winner = ordered[ordered.length - 1];
    const agents = (await discoverSdkAgents()).filter((agent) => agent.agentId === duplicateId);
    expect(agents).toHaveLength(1);
    expect(agents[0].dbPath).toBe(winner);
  } finally {
    await writeIndexDb(dbPaths[0], [{ id: "agent-1", name: "first" }]);
    await writeIndexDb(dbPaths[1], [{ id: "agent-2", name: "second" }]);
  }
});

it("never writes the persisted index inside a read-only scope", async () => {
  const agents = await withReadOnlySqlite(true, () => discoverSdkAgents());
  expect(agents.map((agent) => agent.agentId).sort()).toEqual(["agent-1", "agent-2"]);
  expect(cache.writes).toBe(0);
});
