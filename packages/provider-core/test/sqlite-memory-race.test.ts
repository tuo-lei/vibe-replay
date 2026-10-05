import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string) => {
      const bytes = await actual.readFile(path);
      if (path === race.path)
        await actual.writeFile(path, "checkpoint changed the main file during the read");
      return bytes;
    },
  };
});
const { readSqliteSnapshot, withReadOnlySqlite } = await import("../src/utils.js");

it("rejects concurrent main-file changes during a readonly WASM snapshot read", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-memory-race-"));
  try {
    const path = join(root, "live.db");
    await writeFile(path, "initial main file");
    race.path = await realpath(path);
    await expect(withReadOnlySqlite(true, () => readSqliteSnapshot(race.path))).rejects.toThrow(
      "changed while acquiring a snapshot",
    );
  } finally {
    race.path = "";
    await rm(root, { recursive: true, force: true });
  }
});
