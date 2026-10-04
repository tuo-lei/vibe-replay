import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string) => {
      const bytes = await actual.readFile(path);
      await actual.writeFile(`${path}-wal`, "transaction committed during the read");
      await actual.writeFile(`${path}-shm`, "coordination state");
      return bytes;
    },
  };
});
import { openHermesDb } from "../src/hermes/sqlite.js";
import { buildHermesDb } from "./helpers/db.js";

it("rejects a WAL created while acquiring a read-only Hermes snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-hermes-race-"));
  try {
    const source = join(root, "state.db");
    const db = await buildHermesDb({ sessions: [{ id: "session_race" }], messages: [] });
    try {
      await writeFile(source, db.export());
    } finally {
      db.close();
    }
    await expect(withReadOnlySqlite(true, () => openHermesDb(source))).rejects.toThrow(
      "Checkpoint",
    );
    const ordinary = await openHermesDb(source);
    expect(ordinary?.dbPath).toBe(source);
    ordinary?.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
