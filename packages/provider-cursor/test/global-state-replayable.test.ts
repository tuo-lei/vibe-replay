import { vi } from "vitest";
import { defineReplayableDiscoveryCases } from "./helpers/replayable-cases.js";

// Keep discovery from reading or writing the developer's real ~/.vibe-replay cache.
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { discoverCursorDatabaseSessions } = await import("../src/cursor/sqlite-reader.js");

// Uses the sqlite3 CLI backend (a single EXISTS query) when the binary is installed,
// and the WASM backend otherwise; global-state-replayable-wasm.test.ts pins WASM.
defineReplayableDiscoveryCases("default backend", (dbPath) =>
  discoverCursorDatabaseSessions(dbPath),
);
