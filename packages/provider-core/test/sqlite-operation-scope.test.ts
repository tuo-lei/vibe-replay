import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const copies = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, destination: string, flags?: number) => {
      copies.count++;
      await actual.copyFile(source, destination, flags);
    },
  };
});
const { withSqliteSnapshotScope, withReadOnlySqlite, withSqliteReadSource } =
  await import("../src/utils.js");

it("reuses one ordinary-operation copy across native queries and cleans up on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-operation-copy-")),
    source = join(root, "live.db");
  let staged = "";
  try {
    await writeFile(source, "stable operation data");
    copies.count = 0;
    await expect(
      withSqliteSnapshotScope(async () => {
        for (let index = 0; index < 12; index++) {
          await withSqliteReadSource(source, async (uri) => {
            const path = fileURLToPath(uri);
            if (!staged) staged = path;
            expect(path).toBe(staged);
            expect(path).not.toBe(source);
            expect(await readFile(path, "utf8")).toBe("stable operation data");
          });
        }
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    expect(copies.count).toBe(1);
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("stable operation data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("allows coordinated ordinary WAL reads while a nested zero-write flow still rejects them", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-operation-wal-")),
    source = join(root, "live.db");
  try {
    for (const path of [source, `${source}-wal`, `${source}-shm`]) await writeFile(path, "active");
    const before = await Promise.all(
      [source, `${source}-wal`, `${source}-shm`].map((path) => readFile(path)),
    );
    await withSqliteSnapshotScope(async () => {
      await withSqliteReadSource(source, async (path) => {
        expect(path).toBe(await realpath(source));
      });
      await expect(
        withReadOnlySqlite(true, () => withSqliteReadSource(source, async () => "unexpected")),
      ).rejects.toThrow("active WAL");
    });
    expect(
      await Promise.all([source, `${source}-wal`, `${source}-shm`].map((path) => readFile(path))),
    ).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
