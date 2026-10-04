import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertSqliteWalReadable } from "../src/utils.js";

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
