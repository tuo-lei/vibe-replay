import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";
import { globalStateDbBytes, testSqlite } from "./helpers/global-state-db.js";

const race = vi.hoisted(() => ({ path: "", afterRead: 1, reads: 0 }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (_command: string, _args: string[], _options: unknown, callback: Function) => {
    callback(Object.assign(new Error("sqlite3 unavailable"), { code: "ENOENT" }), "", "");
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string, ...args: any[]) => {
      const bytes = await actual.readFile(path, ...args);
      if (path === race.path && ++race.reads === race.afterRead) {
        await actual.writeFile(`${path}-wal`, "transaction committed during snapshot read");
        await actual.writeFile(`${path}-shm`, "coordination state");
      }
      return bytes;
    },
  };
});
const { discoverCursorDatabaseSessions, parseCursorSqlite } =
  await import("../src/cursor/sqlite-reader.js");
const { loadSdkAgentEnrichment } = await import("../src/cursor/sdk-reader.js");

it.each(["global", "store", "sdk"])(
  "rejects a new WAL during Cursor %s WASM reads",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-race-"));
    const path = join(root, "snapshot.db");
    try {
      let bytes = await globalStateDbBytes();
      if (kind === "store") {
        const SQL = await testSqlite(),
          db = new SQL.Database();
        try {
          db.run(
            "CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY,data BLOB);",
          );
          bytes = db.export();
        } finally {
          db.close();
        }
      }
      await mkdir(root, { recursive: true });
      await writeFile(path, bytes);
      race.path = path;
      race.reads = 0;
      race.afterRead = kind === "store" ? 2 : 1;
      const run =
        kind === "global"
          ? () => discoverCursorDatabaseSessions(path)
          : kind === "store"
            ? () => parseCursorSqlite(root, "11111111-1111-4111-8111-111111111111", path)
            : () =>
                loadSdkAgentEnrichment({
                  agentId: "agent-race",
                  dbPath: path,
                  workspaceRef: root,
                  status: "COMPLETED",
                  createdAt: "",
                  updatedAt: "",
                });
      await expect(withReadOnlySqlite(true, run)).rejects.toThrow("Checkpoint");
      expect(race.reads).toBe(race.afterRead);
    } finally {
      race.path = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);
