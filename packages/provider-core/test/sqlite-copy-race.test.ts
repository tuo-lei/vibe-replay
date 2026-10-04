import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ source: "", copy: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, destination: string, flags?: number) => {
      await actual.copyFile(source, destination, flags);
      if (source === race.source) {
        race.copy = destination;
        await actual.writeFile(source, "a concurrent writer replaced the original");
      }
    },
  };
});
const { withReadOnlySqlite, withSqliteReadSource } = await import("../src/utils.js");

it("rejects a source changed during copying before querying and removes the temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-copy-race-")),
    source = join(root, "live.db");
  try {
    await writeFile(source, "initial snapshot");
    race.source = await realpath(source);
    const query = vi.fn(async () => "should not run");
    await expect(
      withReadOnlySqlite(true, () => withSqliteReadSource(source, query)),
    ).rejects.toThrow("changed while acquiring a snapshot");
    expect(query).not.toHaveBeenCalled();
    await expect(stat(race.copy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("a concurrent writer replaced the original");
  } finally {
    race.source = "";
    await rm(root, { recursive: true, force: true });
  }
});
