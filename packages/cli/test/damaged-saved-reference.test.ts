import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const home = await mkdtemp(join(tmpdir(), "vibe-damaged-reference-"));
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
const { loadCliSession } = await import("../src/session-workflows.js");
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("does not swallow corruption in an exact saved ID or unique prefix, and ignores unrelated corruption", async () => {
  const save = async (slug: string, id: string, broken: boolean) => {
    const dir = join(home, ".vibe-replay", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "replay.json"),
      JSON.stringify({
        meta: { sessionId: id, provider: "codex" },
        scenes: [{ type: "user-prompt", content: "Original" }],
      }),
    );
    if (broken) await writeFile(join(dir, "overlays.json"), "{");
  };
  await save("damaged", "saved-damaged-session", true);
  await save("healthy", "saved-healthy-session", false);
  for (const ref of ["saved-damaged-session", "saved-dam", "damaged"])
    await expect(loadCliSession(ref, { snapshot: true })).rejects.toMatchObject({
      code: "invalid-sidecar",
    });
  expect(
    (await loadCliSession("saved-healthy-session", { snapshot: true })).replay.scenes[0],
  ).toEqual({ type: "user-prompt", content: "Original" });
});
