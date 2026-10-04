import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { withReadOnlySqlite, withSqliteReadSource } from "../src/utils.js";

it("uses one private stable copy across queries and removes it when the readonly flow ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-stable-copy-")),
    source = join(root, "live.db");
  let staged = "";
  try {
    await writeFile(source, "first coherent snapshot");
    await withReadOnlySqlite(true, async () => {
      await withSqliteReadSource(source, async (uri) => {
        expect(uri).toContain("?immutable=1");
        staged = fileURLToPath(uri);
        expect(staged).not.toBe(source);
        expect(await readFile(staged, "utf8")).toBe("first coherent snapshot");
        await writeFile(source, "writer changed the live database");
        expect(await readFile(staged, "utf8")).toBe("first coherent snapshot");
      });
      await withSqliteReadSource(source, async (uri) => {
        expect(fileURLToPath(uri)).toBe(staged);
        expect(await readFile(staged, "utf8")).toBe("first coherent snapshot");
      });
    });
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("writer changed the live database");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes its private copy when a native query fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-stable-copy-failure-")),
    source = join(root, "live.db");
  let staged = "";
  try {
    await writeFile(source, "unchanged source");
    await expect(
      withSqliteReadSource(source, async (uri) => {
        staged = fileURLToPath(uri);
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("unchanged source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
