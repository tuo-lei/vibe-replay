import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/types.js";

const mockHome = join(tmpdir(), `vibe-saved-replay-test-${Date.now()}`);
vi.mock("node:os", async () => ({
  ...(await vi.importActual("node:os")),
  homedir: () => mockHome,
}));
let sourceInfo: SessionInfo;
vi.mock("../src/provider-discovery.js", () => ({
  discoverProvidersSafely: async () => ({
    sessions: [sourceInfo],
    failedProviders: [],
    coverage: [{ provider: "pi", status: "ready", sessionCount: 1 }],
  }),
}));
vi.mock("../src/cache.js", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { loadCliSession } = await import("../src/session-workflows.js");
const { getProvider } = await import("../src/providers/index.js");
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(mockHome, { recursive: true, force: true });
});

describe("saved replay before live parsing", () => {
  it.each(["no-prompts", "unreadable", undefined] as const)(
    "uses the edited snapshot with source status=%s",
    async (transcriptStatus) => {
      const outputDir = join(mockHome, ".vibe-replay", "snapshot");
      await mkdir(outputDir, { recursive: true });
      const replay = {
        meta: {
          sessionId: "saved-session-full",
          slug: "snapshot",
          provider: "pi",
          title: "Saved title",
        },
        scenes: [{ type: "user-prompt", content: "Saved request" }],
      };
      const raw = JSON.stringify(replay);
      await writeFile(join(outputDir, "replay.json"), raw);
      await writeFile(
        join(outputDir, "overlays.json"),
        JSON.stringify({
          version: 1,
          overlays: [
            {
              sceneIndex: 0,
              modifiedValue: "Edited saved request",
              updatedAt: "2026-10-04T00:00:00Z",
            },
          ],
        }),
      );
      await writeFile(
        join(outputDir, "annotations.json"),
        JSON.stringify([{ id: "saved-note", sceneIndex: 0, body: "Saved note" }]),
      );
      sourceInfo = {
        provider: "pi",
        sessionId: "saved-session-full",
        slug: "snapshot",
        title: "Live title",
        project: "/repo",
        cwd: "/repo",
        version: "",
        timestamp: "2026-10-04T00:00:00Z",
        lineCount: 1,
        fileSize: 1,
        filePath: join(mockHome, "missing-source.jsonl"),
        filePaths: [join(mockHome, "missing-source.jsonl")],
        firstPrompt: "Live request",
        transcriptStatus,
      };
      const parse = vi
        .spyOn(getProvider("pi")!, "parse")
        .mockRejectedValue(new Error("Live provider no longer parses this session"));
      const loaded = await loadCliSession("saved-session", { provider: "pi", preferReplay: true });
      expect(loaded.outputDir).toBe(outputDir);
      expect(loaded.replay.meta.title).toBe("Saved title");
      expect(loaded.replay.scenes[0]).toMatchObject({ content: "Edited saved request" });
      expect(loaded.replay.annotations).toMatchObject([{ id: "saved-note" }]);
      expect(parse).not.toHaveBeenCalled();
      expect(await readFile(join(outputDir, "replay.json"), "utf-8")).toBe(raw);
    },
  );
});
