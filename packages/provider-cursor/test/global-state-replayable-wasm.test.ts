import { vi } from "vitest";
import { defineReplayableDiscoveryCases } from "./helpers/replayable-cases.js";

vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
// Force the sql.js backend so the chunked early-exit probe is exercised even where
// the sqlite3 CLI exists.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (_command: string, _args: string[], _options: unknown, callback: Function) => {
    callback(Object.assign(new Error("sqlite3 unavailable"), { code: "ENOENT" }), "", "");
  },
}));
const { discoverCursorDatabaseSessions } = await import("../src/cursor/sqlite-reader.js");

defineReplayableDiscoveryCases("WASM backend", (dbPath) => discoverCursorDatabaseSessions(dbPath));
