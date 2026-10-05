import { mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";

const race = vi.hoisted(() => ({ path: "", copy: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, destination: string, flags?: number) => {
      await actual.copyFile(source, destination, flags);
      if (source === race.path) {
        race.copy = destination;
        await actual.appendFile(source, "concurrent source update");
      }
    },
  };
});
const { loadSdkAgentEnrichment } = await import("../src/cursor/sdk-reader.js");

it("propagates a native probe race for an SDK index above the WASM size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-sdk-probe-race-")),
    source = join(root, "index.db");
  try {
    await writeFile(source, "snapshot source");
    const file = await open(source, "r+");
    try {
      await file.truncate(129 * 1024 * 1024);
    } finally {
      await file.close();
    }
    race.path = await realpath(source);
    await expect(
      withReadOnlySqlite(true, () =>
        loadSdkAgentEnrichment({
          agentId: "agent-large-probe",
          dbPath: source,
          workspaceRef: root,
          status: "COMPLETED",
          createdAt: "",
          updatedAt: "",
        }),
      ),
    ).rejects.toThrow("changed while acquiring a snapshot");
    await expect(stat(race.copy)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    race.path = "";
    await rm(root, { recursive: true, force: true });
  }
});
