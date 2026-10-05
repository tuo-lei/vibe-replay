import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const denied = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) => (path === denied.path ? false : actual.existsSync(path)),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const error = () => Object.assign(new Error("access denied"), { code: "EACCES" });
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === denied.path) throw error();
      return actual.stat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] === denied.path) throw error();
      return actual.open(...args);
    },
  };
});
const { readSqliteSnapshot, withReadOnlySqlite, withSqliteReadSource } =
  await import("../src/utils.js");

it.each([
  ["wal", "native", false],
  ["wal", "native", true],
  ["wal", "memory", true],
  ["journal", "native", false],
  ["journal", "native", true],
  ["journal", "memory", false],
  ["journal", "memory", true],
])(
  "rejects an unverifiable %s hidden by existsSync for %s (zero-write: %s)",
  async (sidecar, kind, readOnly) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-sidecar-denied-"));
    try {
      const source = join(root, "source.db");
      await writeFile(source, "source database bytes");
      const path = await realpath(source);
      denied.path = `${path}-${sidecar}`;
      await writeFile(denied.path, "unverifiable transaction bytes");
      const query = vi.fn(async () => "unsafe snapshot");
      const operation = withReadOnlySqlite(readOnly, () =>
        kind === "native" ? withSqliteReadSource(path, query) : readSqliteSnapshot(path),
      );
      if (sidecar === "journal") await expect(operation).rejects.toThrow("Cannot verify");
      else await expect(operation).rejects.toMatchObject({ code: "EACCES" });
      expect(query).not.toHaveBeenCalled();
      expect(await readFile(path)).toEqual(Buffer.from("source database bytes"));
      expect(await readFile(denied.path)).toEqual(Buffer.from("unverifiable transaction bytes"));
    } finally {
      denied.path = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);
