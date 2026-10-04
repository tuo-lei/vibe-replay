import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ target: "", resolutions: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (path: string) => {
      const real = actual.realpathSync(path);
      if (path === race.target && ++race.resolutions === 2) {
        actual.writeFileSync(`${real}-wal`, "new transaction");
      }
      return real;
    },
  };
});
const { sqliteReadOnlyLocation, withReadOnlySqlite } = await import("../src/utils.js");

it("rejects a WAL that activates between location checks without opening the live path", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-location-race-")),
    path = join(root, "state.db");
  try {
    await writeFile(path, "unchanged main database");
    await writeFile(`${path}-shm`, "unchanged shared memory");
    race.target = path;
    race.resolutions = 0;
    await expect(withReadOnlySqlite(true, () => sqliteReadOnlyLocation(path))).rejects.toThrow(
      "Checkpoint",
    );
    expect(await readFile(path, "utf8")).toBe("unchanged main database");
    expect(await readFile(`${path}-shm`, "utf8")).toBe("unchanged shared memory");
    expect(await readFile(`${path}-wal`, "utf8")).toBe("new transaction");
    race.target = "";
    expect(await sqliteReadOnlyLocation(path)).toBe(await realpath(path));
  } finally {
    race.target = "";
    await rm(root, { recursive: true, force: true });
  }
});
