import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readSidecar, writeSidecar } from "./sidecar.js";
import type { Annotation, SessionOverlays } from "./types.js";

export function scopedSessionSlug(slug: string, targetId?: string): string {
  if (!targetId) return slug;
  const suffix = `--ssh-${createHash("sha1").update(targetId).digest("hex").slice(0, 10)}`;
  return slug.endsWith(suffix) || slug.includes(`${suffix}--id-`) ? slug : `${slug}${suffix}`;
}

function sessionDirs(
  baseDir: string,
  slug: string,
  targetId?: string,
  allowLegacyFallback = true,
): string[] {
  if (targetId) return [join(baseDir, scopedSessionSlug(slug, targetId))];
  return allowLegacyFallback
    ? [join(baseDir, slug), resolve("./vibe-replay", slug)]
    : [join(baseDir, slug)];
}

/** Load annotations from disk for a given slug */
export async function loadAnnotations(
  baseDir: string,
  slug: string,
  targetId?: string,
  allowLegacyFallback = true,
  strict = false,
): Promise<Annotation[]> {
  for (const dir of sessionDirs(baseDir, slug, targetId, allowLegacyFallback)) {
    const anns = await readSidecar<Annotation[]>(
      join(dir, "annotations.json"),
      (value) =>
        Array.isArray(value) &&
        (!strict ||
          value.every(
            (a) =>
              !!a &&
              Number.isSafeInteger(a.sceneIndex) &&
              a.sceneIndex >= 0 &&
              typeof a.id === "string" &&
              typeof a.body === "string",
          )),
      strict,
    );
    if (anns) return anns;
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
  await writeSidecar(annPath, annotations);
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
  await writeSidecar(overlayPath, overlays);
}
