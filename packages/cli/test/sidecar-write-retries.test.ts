import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rename: vi.fn(actual.rename) };
});
const { writeSidecar } = await import("../src/sidecar.js");
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(realFs.rename);
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function original() {
  const dir = await mkdtemp(join(tmpdir(), "vibe-sidecar-retry-"));
  roots.push(dir);
  const path = join(dir, "overlays.json");
  await writeFile(path, "original edit");
  return { dir, path };
}

it.each(["EPERM", "EACCES", "EBUSY"])(
  "retries transient %s without removing the original",
  async (code) => {
    const { dir, path } = await original();
    const locked = async () => {
      expect(await readFile(path, "utf-8")).toBe("original edit");
      throw Object.assign(new Error("locked"), { code });
    };
    vi.mocked(rename).mockImplementationOnce(locked).mockImplementationOnce(locked);
    await writeSidecar(path, { version: 1, overlays: [] });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ version: 1, overlays: [] });
    expect(await readdir(dir)).toEqual(["overlays.json"]);
  },
);

it.each(["EIO", "EPERM"])(
  "propagates %s after its retry budget and preserves the prior edit",
  async (code) => {
    const { dir, path } = await original();
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error("cannot replace"), { code }));
    await expect(writeSidecar(path, { version: 1, overlays: [] })).rejects.toMatchObject({ code });
    expect(rename).toHaveBeenCalledTimes(code === "EPERM" ? 6 : 1);
    expect(await readFile(path, "utf-8")).toBe("original edit");
    expect(await readdir(dir)).toEqual(["overlays.json"]);
  },
);
