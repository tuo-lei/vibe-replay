import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const transaction = vi.hoisted(() => ({ path: "", mode: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string) => {
      const bytes = await actual.readFile(path);
      if (path === transaction.path && transaction.mode) {
        await actual.writeFile(`${path}-journal`, Buffer.alloc(1024, 1));
        // Same-size commit entirely within acquisition; neither boundary sees
        // an active journal, but the main file's identity/timestamps changed.
        await actual.writeFile(path, Buffer.alloc(bytes.length, 2));
        if (transaction.mode === "delete") await actual.rm(`${path}-journal`);
        else {
          const journal = Buffer.alloc(1024, 1);
          journal.fill(0, 0, 28);
          await actual.writeFile(`${path}-journal`, journal);
        }
      }
      return bytes;
    },
  };
});
const { readSqliteSnapshot } = await import("../src/utils.js");

it.each(["delete", "persist"])(
  "rejects an ordinary memory snapshot when a %s journal transaction commits during acquisition",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-completed-commit-"));
    try {
      const path = join(root, "source.db");
      await writeFile(path, Buffer.alloc(8192, 1));
      transaction.path = await realpath(path);
      transaction.mode = mode;
      await expect(readSqliteSnapshot(transaction.path)).rejects.toThrow(
        "changed while acquiring a snapshot",
      );
      transaction.mode = "";
      expect(await readFile(path)).toEqual(Buffer.alloc(8192, 2));
      // Once the source is stable, the same ordinary operation recovers.
      expect(await readSqliteSnapshot(transaction.path)).toEqual(Buffer.alloc(8192, 2));
    } finally {
      transaction.path = "";
      transaction.mode = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);
