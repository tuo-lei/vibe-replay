import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { safeSlug } from "../server-core.js";

/** Archive marker directory (one empty file per archived slug). */
const ARCHIVE_DIR = ".archive";

async function getArchivedSlugs(baseDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(baseDir, ARCHIVE_DIR));
    return new Set(entries);
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
    await archiveSlug(baseDir, slug);
    return c.json({ ok: true });
  });

  app.delete("/api/archive/:slug", async (c) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    await unarchiveSlug(baseDir, slug);
    return c.json({ ok: true });
  });
}
