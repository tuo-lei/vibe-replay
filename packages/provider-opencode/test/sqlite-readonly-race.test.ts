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
import { openOpencodeDb } from "../src/opencode/sqlite.js";
import { buildOpencodeDb } from "./helpers/db.js";

it("rejects a WAL created while acquiring a read-only OpenCode snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-opencode-race-"));
  try {
    const source = join(root, "opencode.db");
    const db = await buildOpencodeDb({ session: [{ id: "native-race" }], messages: [] });
    try {
      await writeFile(source, db.export());
    } finally {
      db.close();
    }
    await expect(withReadOnlySqlite(true, () => openOpencodeDb(source))).rejects.toThrow(
      "Checkpoint",
    );
    const ordinary = await openOpencodeDb(source);
    expect(ordinary?.dbPath).toBe(source);
    ordinary?.db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
