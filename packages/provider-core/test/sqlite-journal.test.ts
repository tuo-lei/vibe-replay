import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ source: "", race: "", staged: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, destination: string, flags?: number) => {
      await actual.copyFile(source, destination, flags);
      if (source === state.source && state.race === "copy") {
        state.staged = destination;
        await actual.writeFile(`${source}-journal`, Buffer.alloc(1024, 1));
      }
    },
    readFile: async (path: string) => {
      const bytes = await actual.readFile(path);
      if (path === state.source && state.race === "memory")
        await actual.writeFile(`${path}-journal`, Buffer.alloc(1024, 1));
      return bytes;
    },
  };
});
const { readSqliteSnapshot, withReadOnlySqlite, withSqliteReadSource } =
  await import("../src/utils.js");

it.each([
  ["native", false],
  ["native", true],
  ["memory", false],
  ["memory", true],
])("rejects a pending rollback journal for %s (zero-write: %s)", async (kind, readOnly) => {
  const root = await mkdtemp(join(tmpdir(), "vibe-pending-journal-")),
    source = join(root, "source.db");
  try {
    await writeFile(source, "database bytes");
    await writeFile(`${source}-journal`, Buffer.alloc(1024, 1));
    const before = [await readFile(source), await readFile(`${source}-journal`)];
    await expect(
      withReadOnlySqlite(readOnly, () =>
        kind === "native"
          ? withSqliteReadSource(source, async () => "unsafe query")
          : readSqliteSnapshot(source),
      ),
    ).rejects.toThrow("rollback journal");
    expect([await readFile(source), await readFile(`${source}-journal`)]).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["native", "memory"])(
  "allows a committed PERSIST journal's zeroed header for %s",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-committed-journal-")),
      source = join(root, "source.db"),
      journal = Buffer.alloc(1024, 1);
    journal.fill(0, 0, 28);
    try {
      await writeFile(source, "committed bytes");
      await writeFile(`${source}-journal`, journal);
      const bytes = await withReadOnlySqlite(true, () =>
        kind === "native"
          ? withSqliteReadSource(source, async (uri) => readFile(fileURLToPath(uri)))
          : readSqliteSnapshot(source),
      );
      expect(bytes.toString()).toBe("committed bytes");
      expect(await readFile(`${source}-journal`)).toEqual(journal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["copy", "memory"])(
  "rejects rollback journal activation during %s snapshot acquisition",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-journal-race-")),
      source = join(root, "source.db");
    try {
      await writeFile(source, "stable bytes");
      state.source = await realpath(source);
      state.race = kind;
      state.staged = "";
      await expect(
        withReadOnlySqlite(true, () =>
          kind === "copy"
            ? withSqliteReadSource(state.source, async () => "unsafe query")
            : readSqliteSnapshot(state.source),
        ),
      ).rejects.toThrow("rollback journal");
      if (kind === "copy")
        await expect(stat(state.staged)).rejects.toMatchObject({ code: "ENOENT" });
      state.race = "";
      expect(await readFile(source)).toEqual(Buffer.from("stable bytes"));
    } finally {
      state.race = "";
      state.source = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);
