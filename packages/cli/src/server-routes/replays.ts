import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { readFileCache, writeFileCache } from "../cache.js";
import { generateOutput } from "../generator.js";
import { sessionForExternalOutput } from "../overlays.js";
import { getErrorMessage, requireSlug, safeSlug, safeTargetId } from "../server-core.js";
import type { ReplaySummary } from "../server-types.js";
import type { ReplaySession } from "../types.js";
import { normalizeTitle } from "../utils.js";

interface ReplaysRouteDeps {
  baseDir: string;
  scanReplays: () => Promise<ReplaySummary[]>;
  refreshReplaysCache: () => Promise<ReplaySummary[] | null>;
  syncSourcesCacheWithReplays: (replays: ReplaySummary[]) => Promise<void>;
  replaysCacheKey: string;
  loadSession: (slug: string, targetId?: string) => Promise<ReplaySession>;
}

/** Session loading and generated replay dashboard routes. */
export function registerReplayRoutes(app: Hono, deps: ReplaysRouteDeps): void {
  const {
    baseDir,
    scanReplays,
    refreshReplaysCache,
    syncSourcesCacheWithReplays,
    replaysCacheKey,
    loadSession,
  } = deps;

  app.get("/api/session", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      const session = await loadSession(result.slug, targetId);
      return c.json(sessionForExternalOutput(session));
    } catch {
      return c.json({ error: `Session not found: ${result.slug}` }, 404);
    }
  });

  const getCachedReplays = async (c: Context) => {
    const cached = await readFileCache<ReplaySummary[]>(replaysCacheKey);
    return c.json({
      sessions: cached?.data || [],
      cachedAt: cached?.updatedAt,
    });
  };

  app.get("/api/sessions/cached", getCachedReplays);
  app.get("/api/replays/cached", getCachedReplays);

  const getReplays = async (c: Context) => {
    const sessions = await scanReplays();
    await writeFileCache(replaysCacheKey, sessions);
    return c.json(sessions);
  };

  app.get("/api/sessions", getReplays);
  app.get("/api/replays", getReplays);

  const patchReplay = async (c: Context) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);

    let body: { title?: unknown };
    try {
      body = await c.req.json<{ title?: unknown }>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.title !== "string") {
      return c.json({ error: "title field required" }, 400);
    }

    try {
      const target = await loadSession(slug, targetId);
      target.meta.title = normalizeTitle(body.title);

      const targetDir = join(baseDir, slug);
      await writeFile(join(targetDir, "replay.json"), JSON.stringify(target), "utf-8");
      await generateOutput(target, targetDir);
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);

      return c.json({ ok: true, title: target.meta.title });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  };

  app.patch("/api/sessions/:slug", patchReplay);
  app.patch("/api/replays/:slug", patchReplay);

  const deleteReplay = async (c: Context) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(slug, targetId);
      await rm(join(baseDir, slug), { recursive: true });
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  };

  app.delete("/api/sessions/:slug", deleteReplay);
  app.delete("/api/replays/:slug", deleteReplay);
}
