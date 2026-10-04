import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  wal: "",
  shm: "",
  checkpoint: false,
  code: "",
  reads: 0,
  removeAt: 1,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === race.shm) {
        await actual.rm(race.shm);
        if (race.checkpoint) await actual.rm(`${race.shm.slice(0, -4)}-wal`);
      }
      if (args[0] === race.wal) {
        if (race.code) throw Object.assign(new Error("sidecar access failed"), { code: race.code });
        if (++race.reads >= race.removeAt) await actual.rm(race.wal, { force: true });
      }
      return actual.stat(...args);
    },
  };
});

it.each([false, true])(
  "rechecks WAL if SHM disappears (checkpoint completed: %s)",
  async (checkpoint) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-shm-removal-"));
    try {
      const source = join(root, "source.db");
      await writeFile(source, "database bytes");
      const path = await realpath(source);
      race.shm = `${path}-shm`;
      race.checkpoint = checkpoint;
      await writeFile(`${path}-wal`, "active WAL frames");
      await writeFile(race.shm, "coordinated WAL");
      if (checkpoint) await expect(assertSqliteWalReadable(path)).resolves.toBeUndefined();
      else {
        await expect(assertSqliteWalReadable(path)).rejects.toThrow("Checkpoint");
        expect(await readFile(`${path}-wal`)).toEqual(Buffer.from("active WAL frames"));
      }
      expect(await readFile(path)).toEqual(Buffer.from("database bytes"));
    } finally {
      race.shm = "";
      race.checkpoint = false;
      await rm(root, { recursive: true, force: true });
    }
  },
);
const {
  assertSqliteWalReadable,
  readSqliteSnapshot,
  sqliteReadOnlyLocation,
  withReadOnlySqlite,
  withSqliteReadSource,
} = await import("../src/utils.js");

it.each([
  ["guard", false],
  ["guard", true],
  ["memory", true],
  ["native", false],
  ["native", true],
  ["location", false],
  ["location", true],
  ["native-late", false],
  ["location-late", false],
])(
  "accepts a checkpoint removing WAL during %s validation (zero-write: %s)",
  async (kind, readOnly) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-wal-removal-"));
    try {
      const source = join(root, "source.db");
      await writeFile(source, "checkpointed bytes");
      const path = await realpath(source);
      race.wal = `${path}-wal`;
      race.reads = 0;
      race.removeAt = kind.endsWith("-late") ? 2 : 1;
      await writeFile(race.wal, "previous WAL frames");
      if (race.removeAt === 2) await writeFile(`${path}-shm`, "coordinated WAL");
      const bytes = await withReadOnlySqlite(readOnly, async () => {
        if (kind === "guard") {
          await assertSqliteWalReadable(path);
          return readFile(path);
        }
        if (kind === "memory") return readSqliteSnapshot(path);
        if (kind.startsWith("native"))
          return withSqliteReadSource(path, async (uri) => readFile(fileURLToPath(uri)));
        return readFile(fileURLToPath(await sqliteReadOnlyLocation(path)));
      });
      expect(bytes.toString()).toBe("checkpointed bytes");
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      race.wal = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves WAL access failures other than disappearance", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-wal-access-"));
  try {
    const source = join(root, "source.db");
    await writeFile(source, "database bytes");
    race.wal = `${await realpath(source)}-wal`;
    race.code = "EACCES";
    await writeFile(race.wal, "active WAL frames");
    await expect(
      withReadOnlySqlite(true, () => assertSqliteWalReadable(source)),
    ).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await readFile(race.wal)).toEqual(Buffer.from("active WAL frames"));
  } finally {
    race.wal = "";
    race.code = "";
    await rm(root, { recursive: true, force: true });
  }
});
