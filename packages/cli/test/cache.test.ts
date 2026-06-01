import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_VERSION } from "../src/version.js";

const homes: string[] = [];

async function importCacheForHome(home: string) {
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return { ...actual, homedir: () => home };
  });
  return import("../src/cache.js");
}

function cachePath(home: string, key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(home, ".vibe-replay", "cache", `${safeKey}.json`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:os");
  vi.resetModules();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("file cache", () => {
  it("round-trips data through the versioned cache envelope", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibe-cache-test-"));
    homes.push(home);
    const { readFileCache, writeFileCache } = await importCacheForHome(home);

    await writeFileCache("sources/project:one", { sessions: 3 });
    const raw = JSON.parse(await readFile(cachePath(home, "sources/project:one"), "utf-8"));

    expect(raw).toMatchObject({
      envelopeVersion: 1,
      appVersion: CLI_VERSION,
      data: { sessions: 3 },
    });
    expect(typeof raw.updatedAt).toBe("string");
    await expect(readFileCache<{ sessions: number }>("sources/project:one")).resolves.toMatchObject(
      {
        data: { sessions: 3 },
      },
    );
  });

  it("treats incompatible or malformed cache entries as misses", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibe-cache-test-"));
    homes.push(home);
    const { readFileCache } = await importCacheForHome(home);

    await mkdir(join(home, ".vibe-replay", "cache"), { recursive: true });
    await writeFile(cachePath(home, "bad-version"), JSON.stringify({ data: "stale" }), "utf-8");
    await writeFile(cachePath(home, "bad-json"), "{", "utf-8");

    await expect(readFileCache("bad-version")).resolves.toBeNull();
    await expect(readFileCache("bad-json")).resolves.toBeNull();
    await expect(readFileCache("missing")).resolves.toBeNull();
  });

  it("honors the disable flag for reads and writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibe-cache-test-"));
    homes.push(home);
    const { readFileCache, writeFileCache } = await importCacheForHome(home);

    vi.stubEnv("VIBE_REPLAY_DISABLE_FILE_CACHE", "1");
    await writeFileCache("disabled", { ok: true });

    await expect(readFileCache("disabled")).resolves.toBeNull();
    await expect(readFile(cachePath(home, "disabled"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
