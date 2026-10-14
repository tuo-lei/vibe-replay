import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteSnapshotRequiredError } from "@vibe-replay/provider-core/utils";

// Counts real sqlite3 spawns while still running them.
const spawns = vi.hoisted(() => ({ count: 0, sql: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = ((...args: Parameters<typeof actual.execFile>) => {
    spawns.count++;
    return actual.execFile(...args);
  }) as typeof actual.execFile;
  (execFile as any)[promisify.custom] = (...args: any[]) => {
    spawns.count++;
    spawns.sql.push((args[1] as string[]).join(" "));
    return (actual.execFile as any)[promisify.custom](...args);
  };
  return { ...actual, execFile };
});
const { loadSdkAgentEnrichment } = await import("../src/cursor/sdk-reader.js");

const hasSqlite3 = spawnSync("sqlite3", ["-version"]).status === 0;

let root: string;
let nextDir = 0;

function toolEvents(runId: string, callId: string) {
  const call = (status: string, extra: object) => ({
    schemaVersion: 1,
    type: "sdk_message",
    message: {
      type: "tool_call",
      call_id: callId,
      name: "shell",
      status,
      args: { command: "echo hi" },
      ...extra,
    },
  });
  return [
    { run_id: runId, seq: 1, payload: call("running", {}) },
    {
      run_id: runId,
      seq: 2,
      payload: call("completed", {
        result: { status: "success", value: { exitCode: 0, stdout: "hi\n", stderr: "" } },
      }),
    },
  ];
}

/**
 * Three agents in one index: one with runs and events, one with runs but no events, and
 * one with no runs at all (sqlite3 prints nothing for an empty result set).
 */
async function writeIndexDb(): Promise<string> {
  const dir = join(root, String(nextDir++));
  await mkdir(dir, { recursive: true });
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT, status TEXT, name TEXT, created_at TEXT, updated_at TEXT);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, status TEXT, model TEXT, started_at TEXT, finished_at TEXT, result TEXT, usage_json TEXT, created_at TEXT, updated_at TEXT);" +
      "CREATE TABLE run_events (run_id TEXT, seq INTEGER, offset TEXT, event_type TEXT, payload_json TEXT, created_at TEXT, PRIMARY KEY (run_id, seq));",
  );
  for (const id of ["agent-events", "agent-no-events", "agent-no-runs"]) {
    db.run("INSERT INTO agents VALUES (?, '/work', 'IDLE', ?, '', '')", [id, id]);
  }
  const insertRun = (runId: string, agentId: string, usage: string | null) =>
    db.run("INSERT INTO runs VALUES (?, ?, 1, 'FINISHED', 'composer-2', ?, ?, 'done', ?, ?, ?)", [
      runId,
      agentId,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:31.000Z",
      usage,
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:31.000Z",
    ]);
  insertRun(
    "run-events",
    "agent-events",
    JSON.stringify({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }),
  );
  insertRun("run-no-events", "agent-no-events", null);
  for (const event of toolEvents("run-events", "call-1")) {
    db.run("INSERT INTO run_events VALUES (?, ?, ?, 'run_stream_event', ?, ?)", [
      event.run_id,
      event.seq,
      String(event.seq),
      JSON.stringify(event.payload),
      "2026-01-01T00:00:02.000Z",
    ]);
  }
  const path = join(dir, "index.db");
  await writeFile(path, Buffer.from(db.export()));
  db.close();
  return path;
}

const agent = (agentId: string, dbPath: string) => ({
  agentId,
  workspaceRef: "/work",
  status: "IDLE",
  createdAt: "",
  updatedAt: "",
  dbPath,
});

/** Maps do not survive JSON, and the database location legitimately differs. */
function comparable(value: unknown, dbPath: string) {
  const json = JSON.stringify(value, (_key, item) =>
    item instanceof Map ? { map: [...item.entries()] } : item,
  );
  return JSON.parse(json.replaceAll(JSON.stringify(dbPath).slice(1, -1), "<db>"));
}

async function readAll(dbPath: string) {
  return {
    events: await loadSdkAgentEnrichment(agent("agent-events", dbPath)),
    noEvents: await loadSdkAgentEnrichment(agent("agent-no-events", dbPath)),
    noRuns: await loadSdkAgentEnrichment(agent("agent-no-runs", dbPath)),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vibe-sdk-read-paths-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SDK enrichment read paths", () => {
  it("reads a small index without a WAL in-process, without spawning sqlite3", async () => {
    const dbPath = await writeIndexDb();
    const before = spawns.count;
    const { events, noEvents, noRuns } = await readAll(dbPath);

    expect(spawns.count).toBe(before);
    expect(events?.runs.map((run) => run.runId)).toEqual(["run-events"]);
    expect(events?.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
    });
    const calls = events?.toolCallsByRun.get("run-events") ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "Bash", result: "hi", status: "completed" });
    expect(noEvents?.runs).toHaveLength(1);
    expect(noEvents?.toolCallsByRun.size).toBe(0);
    expect(noRuns).toBeNull();
  });

  it.skipIf(!hasSqlite3)(
    "answers runs and events with one sqlite3 spawn when a WAL may hold newer pages",
    async () => {
      const inProcessPath = await writeIndexDb();
      const inProcess = await readAll(inProcessPath);

      const walPath = await writeIndexDb();
      // A non-empty WAL plus its shared-memory sidecar means sql.js could miss pages.
      await writeFile(`${walPath}-wal`, Buffer.alloc(64, 1));
      await writeFile(`${walPath}-shm`, Buffer.alloc(32768));

      let before = spawns.count;
      const events = await loadSdkAgentEnrichment(agent("agent-events", walPath));
      expect(spawns.count - before).toBe(1);
      // Both SELECTs share one read transaction so a concurrent commit cannot split them.
      expect(spawns.sql.at(-1)).toMatch(
        /BEGIN;.*SELECT \* FROM runs.*SELECT \* FROM run_events.*COMMIT;$/,
      );
      before = spawns.count;
      const noEvents = await loadSdkAgentEnrichment(agent("agent-no-events", walPath));
      expect(spawns.count - before).toBe(1);
      before = spawns.count;
      const noRuns = await loadSdkAgentEnrichment(agent("agent-no-runs", walPath));
      expect(spawns.count - before).toBe(1);

      // Same result as the in-process reader, apart from the database location.
      expect(comparable(events, walPath)).toEqual(comparable(inProcess.events, inProcessPath));
      expect(noEvents?.runs).toHaveLength(1);
      expect(noEvents?.toolCallsByRun.size).toBe(0);
      expect(noRuns).toBeNull();
    },
  );

  it("never reads a database with a pending rollback journal from its main file alone", async () => {
    const dbPath = await writeIndexDb();
    // Any non-zero journal header is an active rollback journal.
    await writeFile(`${dbPath}-journal`, Buffer.alloc(28, 1));

    const before = spawns.count;
    await expect(loadSdkAgentEnrichment(agent("agent-events", dbPath))).rejects.toBeInstanceOf(
      SqliteSnapshotRequiredError,
    );
    expect(spawns.count).toBe(before);
  });
});
