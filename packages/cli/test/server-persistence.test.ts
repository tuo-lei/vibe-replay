import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAnnotations, saveAnnotations, saveOverlays } from "../src/server-persistence.js";
import type { Annotation, SessionOverlays } from "../src/types.js";

const originalCwd = process.cwd();
const roots: string[] = [];

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    sceneIndex: 1,
    body: "Needs follow-up",
    author: "vibe-replay",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    resolved: false,
    ...overrides,
  };
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server persistence", () => {
  it("loads annotations from primary, fallback, and malformed stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-server-persistence-"));
    roots.push(root);
    process.chdir(root);
    const baseDir = join(root, "primary");

    await expect(loadAnnotations(baseDir, "missing")).resolves.toEqual([]);

    await mkdir(join(baseDir, "bad"), { recursive: true });
    await writeFile(join(baseDir, "bad", "annotations.json"), JSON.stringify({ nope: true }));
    await expect(loadAnnotations(baseDir, "bad")).resolves.toEqual([]);

    const primaryAnnotation = makeAnnotation({ id: "primary" });
    await mkdir(join(baseDir, "primary"), { recursive: true });
    await writeFile(
      join(baseDir, "primary", "annotations.json"),
      JSON.stringify([primaryAnnotation]),
    );
    await expect(loadAnnotations(baseDir, "primary")).resolves.toEqual([primaryAnnotation]);

    const fallbackAnnotation = makeAnnotation({ id: "fallback" });
    await mkdir(join(root, "vibe-replay", "fallback"), { recursive: true });
    await writeFile(
      join(root, "vibe-replay", "fallback", "annotations.json"),
      JSON.stringify([fallbackAnnotation]),
    );

    await expect(loadAnnotations(baseDir, "fallback")).resolves.toEqual([fallbackAnnotation]);
  });

  it("creates the slug directory before saving annotations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-server-persistence-"));
    roots.push(root);
    const baseDir = join(root, "primary");
    const annotation = makeAnnotation();

    await saveAnnotations(baseDir, "session-a", [annotation]);

    await expect(
      readFile(join(baseDir, "session-a", "annotations.json"), "utf-8").then(JSON.parse),
    ).resolves.toEqual([annotation]);
  });

  it("creates the slug directory before saving overlays", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-server-persistence-"));
    roots.push(root);
    const baseDir = join(root, "primary");
    const overlays: SessionOverlays = {
      version: 1,
      overlays: [
        {
          id: "overlay-1",
          sceneIndex: 2,
          field: "content",
          originalValue: "Hello",
          modifiedValue: "Bonjour",
          source: { type: "translate", params: { from: "en", to: "fr" } },
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    };

    await saveOverlays(baseDir, "session-a", overlays);

    await expect(
      readFile(join(baseDir, "session-a", "overlays.json"), "utf-8").then(JSON.parse),
    ).resolves.toEqual(overlays);
  });
});
