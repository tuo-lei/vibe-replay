import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { sessionLocationHash } from "@vibe-replay/types";
import { loadRemoteSourceConfigs } from "../remote.js";
import { safeSlug, safeTargetId } from "../server-core.js";

/** Archive marker directory (one empty file per archived slug). */
const ARCHIVE_DIR = ".archive";

function archiveMarkerKey(slug: string, targetId?: string): string {
  return targetId ? `${slug}--ssh-${sessionLocationHash(targetId)}` : slug;
}

function legacyArchiveMarkerKey(slug: string, targetId?: string): string | undefined {
  return targetId ? `${slug}--ssh-${targetId}` : undefined;
}

function normalizeArchiveMarker(entry: string, targetIds: ReadonlySet<string>): string {
  for (const targetId of targetIds) {
    const suffix = `--ssh-${targetId}`;
    if (entry.endsWith(suffix)) {
      const slug = entry.slice(0, -suffix.length);
      if (safeSlug(slug)) return archiveMarkerKey(slug, targetId);
    }
  }

  // Older versions stored the raw target id in the marker name. Preserve
  // those markers even if the target was removed from the current config.
  // A current marker is exactly the 16-hex-character output of
  // sessionLocationHash, so leave that opaque form unchanged.
  const match = entry.match(/^(.+)--ssh-([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (match && !/^[a-f0-9]{16}$/.test(match[2]) && safeSlug(match[1])) {
    return archiveMarkerKey(match[1], match[2]);
  }
  return entry;
}

interface ReplayArchiveAlias {
  sourceSlug: string;
  targetId: string;
}

async function readReplayArchiveAliases(baseDir: string): Promise<Map<string, ReplayArchiveAlias>> {
  const aliases = new Map<string, ReplayArchiveAlias>();
  const entries = await readdir(baseDir).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!safeSlug(entry)) return;
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(baseDir, entry, "replay.json"), "utf-8"),
        );
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        const meta = (parsed as { meta?: unknown }).meta;
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
        const sourceSlug = safeSlug((meta as { slug?: unknown }).slug as string | undefined);
        const location = (meta as { location?: unknown }).location;
        if (!sourceSlug || !location || typeof location !== "object") return;
        const target = location as { kind?: unknown; id?: unknown };
        if (target.kind !== "ssh" || typeof target.id !== "string") return;
        const targetId = safeTargetId(target.id);
        if (!targetId) return;
        aliases.set(entry, { sourceSlug, targetId });
      } catch {
        // A malformed replay must not prevent the archive list from loading.
      }
    }),
  );
  return aliases;
}

async function getArchivedSlugs(baseDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(baseDir, ARCHIVE_DIR));
    const targets = await loadRemoteSourceConfigs();
    const targetIds = new Set(targets.map((target) => target.id));
    const aliases = await readReplayArchiveAliases(baseDir);
    const normalized = entries.map((entry) => {
      const marker = normalizeArchiveMarker(entry, targetIds);
      for (const [replaySlug, alias] of aliases) {
        if (marker !== `${replaySlug}--ssh-${sessionLocationHash(alias.targetId)}`) continue;
        return archiveMarkerKey(alias.sourceSlug, alias.targetId);
      }
      return marker;
    });
    return new Set(normalized);
  } catch {
    // No archive dir yet — nothing archived.
    return new Set();
  }
}

async function archiveSlug(baseDir: string, slug: string): Promise<void> {
  const dir = join(baseDir, ARCHIVE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, slug), "");
}

async function unarchiveSlug(baseDir: string, slug: string): Promise<void> {
  try {
    await unlink(join(baseDir, ARCHIVE_DIR, slug));
  } catch {
    /* already gone */
  }
}

/** Archive routes — directory-based, one marker file per slug. */
export function registerArchiveRoutes(app: Hono, deps: { baseDir: string }): void {
  const { baseDir } = deps;

  app.get("/api/archived", async (c) => {
    const slugs = await getArchivedSlugs(baseDir);
    return c.json({ slugs: [...slugs] });
  });

  app.post("/api/archive/:slug", async (c) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    await archiveSlug(baseDir, archiveMarkerKey(slug, targetId));
    const legacyKey = legacyArchiveMarkerKey(slug, targetId);
    if (legacyKey) await unarchiveSlug(baseDir, legacyKey);
    return c.json({ ok: true });
  });

  app.delete("/api/archive/:slug", async (c) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    await unarchiveSlug(baseDir, archiveMarkerKey(slug, targetId));
    const legacyKey = legacyArchiveMarkerKey(slug, targetId);
    if (legacyKey) await unarchiveSlug(baseDir, legacyKey);
    return c.json({ ok: true });
  });
}
