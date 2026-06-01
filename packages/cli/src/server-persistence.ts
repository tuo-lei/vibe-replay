import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Annotation, SessionOverlays } from "./types.js";

/** Load annotations from disk for a given slug */
export async function loadAnnotations(baseDir: string, slug: string): Promise<Annotation[]> {
  const dirs = [join(baseDir, slug), resolve("./vibe-replay", slug)];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, "annotations.json"), "utf-8");
      const anns = JSON.parse(raw) as Annotation[];
      if (Array.isArray(anns)) return anns;
    } catch {}
  }
  return [];
}

/** Save annotations to disk for a given slug */
export async function saveAnnotations(
  baseDir: string,
  slug: string,
  annotations: Annotation[],
): Promise<void> {
  const annPath = join(baseDir, slug, "annotations.json");
  await writeFile(annPath, JSON.stringify(annotations, null, 2), "utf-8");
}

export async function saveOverlays(
  baseDir: string,
  slug: string,
  overlays: SessionOverlays,
): Promise<void> {
  const overlayPath = join(baseDir, slug, "overlays.json");
  await writeFile(overlayPath, JSON.stringify(overlays, null, 2), "utf-8");
}
