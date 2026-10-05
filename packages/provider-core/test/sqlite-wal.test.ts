import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  assertSqliteWalReadable,
  sqliteReadOnlyLocation,
  withReadOnlySqlite,
} from "../src/utils.js";

it("does not create a sidecar for an uncoordinated WAL snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-wal-guard-"));
  try {
    const path = join(root, "copy.db");
    await writeFile(`${path}-wal`, "pending WAL frames");
    await expect(assertSqliteWalReadable(path)).rejects.toThrow("Checkpoint");
    expect(existsSync(`${path}-shm`)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("allows a coordinated WAL snapshot and a checkpointed empty WAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-wal-guard-"));
  try {
    const path = join(root, "copy.db");
    await expect(assertSqliteWalReadable(path)).resolves.toBeUndefined();
    await writeFile(`${path}-wal`, "");
    await expect(assertSqliteWalReadable(path)).resolves.toBeUndefined();
    await writeFile(`${path}-wal`, "pending WAL frames");
    await writeFile(`${path}-shm`, "shared-memory coordination");
    await expect(assertSqliteWalReadable(path)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "checks WAL sidecars at the target of a database file symlink",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-wal-symlink-"));
    try {
      const path = join(root, "original.db"),
        alias = join(root, "alias.db");
      await writeFile(path, "database placeholder");
      await writeFile(`${path}-wal`, "pending WAL frames");
      await symlink(path, alias);
      await expect(assertSqliteWalReadable(alias)).rejects.toThrow("Checkpoint");
      expect(existsSync(`${path}-shm`)).toBe(false);
      expect(existsSync(`${alias}-shm`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("opens a checkpointed database immutably with URI-safe special characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-checkpointed-wal-"));
  try {
    const path = join(root, "copy #snapshot.db");
    await writeFile(path, "checkpointed database");
    const uri = await sqliteReadOnlyLocation(path);
    expect(uri).toMatch(/^file:.*copy%20%23snapshot\.db\?immutable=1$/);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects coordinated active WAL in a zero-write scope without changing ordinary readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-wal-scope-"));
  try {
    const path = join(root, "copy.db");
    await writeFile(path, "database");
    await writeFile(`${path}-wal`, "active WAL frames");
    await writeFile(`${path}-shm`, "existing coordination state");
    const results = await Promise.allSettled([
      withReadOnlySqlite(true, () => sqliteReadOnlyLocation(path)),
      sqliteReadOnlyLocation(path),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { message: expect.stringContaining("Checkpoint") },
    });
    expect(results[1]).toEqual({ status: "fulfilled", value: realpathSync(path) });
    await expect(sqliteReadOnlyLocation(path)).resolves.toBe(realpathSync(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
