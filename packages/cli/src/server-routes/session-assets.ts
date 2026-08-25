import type { Hono } from "hono";
import { loadOverlays } from "../overlays.js";
import { getErrorMessage, requireSlug, safeTargetId } from "../server-core.js";
import { loadAnnotations, saveAnnotations, saveOverlays } from "../server-persistence.js";
import type { Annotation, ReplaySession, SessionOverlays } from "../types.js";

export function registerSessionAssetRoutes(
  app: Hono,
  deps: {
    baseDir: string;
    loadSession: (slug: string, targetId?: string) => Promise<ReplaySession>;
  },
): void {
  const { baseDir, loadSession } = deps;

  // --- Annotations (requires slug) ---
  app.get("/api/annotations", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const anns = await loadAnnotations(baseDir, result.slug, targetId);
    return c.json(anns);
  });

  app.post("/api/annotations", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    let body: Annotation[];
    try {
      body = await c.req.json<Annotation[]>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      await saveAnnotations(baseDir, result.slug, body, targetId);
    } catch (err) {
      return c.json({ error: `Failed to save annotations: ${getErrorMessage(err)}` }, 500);
    }
    return c.json({ ok: true });
  });

  // --- Overlays (requires slug) ---
  app.get("/api/overlays", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const overlays = await loadOverlays(baseDir, result.slug, targetId);
    return c.json(overlays);
  });

  app.post("/api/overlays", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    let body: SessionOverlays;
    try {
      body = await c.req.json<SessionOverlays>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body || !Array.isArray(body.overlays)) {
      return c.json({ error: "invalid overlays shape" }, 400);
    }
    try {
      await saveOverlays(baseDir, result.slug, body, targetId);
    } catch (err) {
      return c.json({ error: `Failed to save overlays: ${getErrorMessage(err)}` }, 500);
    }
    return c.json({ ok: true });
  });
}
