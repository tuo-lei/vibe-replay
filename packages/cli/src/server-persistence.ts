import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Annotation, SessionOverlays } from "./types.js";

export function scopedSessionSlug(slug: string, targetId?: string): string {
  if (!targetId) return slug;
  const suffix = `--ssh-${createHash("sha1").update(targetId).digest("hex").slice(0, 10)}`;
  return slug.endsWith(suffix) ? slug : `${slug}${suffix}`;
}

function sessionDirs(baseDir: string, slug: string, targetId?: string): string[] {
  if (targetId) return [join(baseDir, scopedSessionSlug(slug, targetId))];
  return [join(baseDir, slug), resolve("./vibe-replay", slug)];
}

/** Load annotations from disk for a given slug */
export async function loadAnnotations(
  baseDir: string,
  slug: string,
  targetId?: string,
): Promise<Annotation[]> {
  for (const dir of sessionDirs(baseDir, slug, targetId)) {
    try {
      const raw = await readFile(join(dir, "annotations.json"), "utf-8");
      const anns = JSON.parse(raw) as Annotation[];
      if (Array.isArray(anns)) return anns;
    } catch {
      // annotations.json is optional and may be absent or corrupt in this dir;
      // fall through to the next candidate dir and default to [].
    }
  }
  return [];
}

/** Save annotations to disk for a given slug */
export async function saveAnnotations(
  baseDir: string,
  slug: string,
  annotations: Annotation[],
  targetId?: string,
): Promise<void> {
  const dir = join(baseDir, scopedSessionSlug(slug, targetId));
  await mkdir(dir, { recursive: true });
  const annPath = join(dir, "annotations.json");
  await writeFile(annPath, JSON.stringify(annotations, null, 2), "utf-8");
}

/** Save scene overlays to disk for a given slug */
export async function saveOverlays(
  baseDir: string,
  slug: string,
  overlays: SessionOverlays,
  targetId?: string,
): Promise<void> {
  const dir = join(baseDir, scopedSessionSlug(slug, targetId));
  await mkdir(dir, { recursive: true });
  const overlayPath = join(dir, "overlays.json");
  await writeFile(overlayPath, JSON.stringify(overlays, null, 2), "utf-8");
}
