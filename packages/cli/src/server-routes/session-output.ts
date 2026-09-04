import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { generateGitHubGif } from "../formatters/gif.js";
import { generateGitHubMarkdown, generateGitHubSvg } from "../formatters/github.js";
import { generateOutput } from "../generator.js";
import {
  loadOverlays,
  sessionForExternalOutput,
  sessionWithEffectiveContent,
} from "../overlays.js";
import { loadSavedCloudInfo, publishCloudWithOverlays } from "../publishers/cloud.js";
import { checkPublishStatus, loadSavedGistInfo, publishGist } from "../publishers/gist.js";
import { getErrorMessage, requireSlug, safeTargetId } from "../server-core.js";
import { scanForSecrets } from "../scan.js";
import type { ReplaySession } from "../types.js";

interface SessionOutputRouteDeps {
  baseDir: string;
  loadSession: (slug: string, targetId?: string) => Promise<ReplaySession>;
}

/** Session metadata, publishing, and export routes. */
export function registerSessionOutputRoutes(app: Hono, deps: SessionOutputRouteDeps): void {
  const { baseDir, loadSession } = deps;

  app.get("/api/gh-status", (c) => c.json(checkPublishStatus()));

  // Gist info for a session (requires slug)
  app.get("/api/gist-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const targetDir = join(baseDir, result.slug);
    const gist = await loadSavedGistInfo(targetDir);
    if (!gist) return c.json({ gist: null });
    return c.json({ gist });
  });

  // Delete stale gist info (gist deleted on GitHub)
  app.delete("/api/gist-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const metaPath = join(baseDir, result.slug, ".vibe-replay-gist.json");
    await unlink(metaPath).catch(() => {});
    return c.json({ ok: true });
  });

  // Cloud info for a session (requires slug)
  app.get("/api/cloud-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const targetDir = join(baseDir, result.slug);
    const cloud = await loadSavedCloudInfo(targetDir);
    if (!cloud) return c.json({ cloud: null });
    return c.json({ cloud });
  });

  // Save cloud info locally (after browser-side upload)
  app.post("/api/cloud-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const targetDir = join(baseDir, result.slug);
    const body = await c.req.json();
    if (!body.id || !body.url) return c.json({ error: "Missing id/url" }, 400);
    const metaPath = join(targetDir, ".vibe-replay-cloud.json");
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          id: body.id,
          url: body.url,
          expiresAt: body.expiresAt,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    return c.json({ ok: true });
  });

  // Delete cloud info locally
  app.delete("/api/cloud-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    try {
      await loadSession(result.slug, targetId);
    } catch {
      return c.json({ error: "session not found" }, 404);
    }
    const metaPath = join(baseDir, result.slug, ".vibe-replay-cloud.json");
    await unlink(metaPath).catch(() => {});
    return c.json({ ok: true });
  });

  // Publish to Gist (requires slug)
  app.post("/api/publish/gist", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSession(result.slug, targetId);
      const overlaysData = await loadOverlays(baseDir, result.slug, targetId);
      const targetSession = sessionForExternalOutput(
        sessionWithEffectiveContent(rawSession, overlaysData),
      );

      // Write effective content for gist, then restore the original replay.json
      const replayPath = join(targetDir, "replay.json");
      const originalContent = await readFile(replayPath, "utf-8");
      await writeFile(replayPath, JSON.stringify(targetSession), "utf-8");

      try {
        const title = targetSession.meta.title || targetSession.meta.slug;
        const savedGist = await loadSavedGistInfo(targetDir);
        const gistResult = await publishGist(targetDir, title, {
          overwrite: savedGist || undefined,
        });
        return c.json(gistResult);
      } finally {
        // Always restore original replay.json
        await writeFile(replayPath, originalContent, "utf-8");
      }
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // Publish to cloud (R2) — overlay merging is handled by publishCloudWithOverlays
  app.post("/api/publish/cloud", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      await loadSession(result.slug, targetId);
      const body = await c.req.json().catch(() => ({}));
      const cloudResult = await publishCloudWithOverlays(targetDir, {
        visibility: body.visibility || "unlisted",
        targetId: targetId || undefined,
      });
      return c.json(cloudResult);
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // Export HTML (requires slug)
  app.post("/api/export/html", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSession(result.slug, targetId);
      const overlaysData = await loadOverlays(baseDir, result.slug, targetId);
      const targetSession = sessionForExternalOutput(
        sessionWithEffectiveContent(rawSession, overlaysData),
      );

      // generateOutput writes replay.json — save/restore to avoid destructive overwrite
      const replayPath = join(targetDir, "replay.json");
      const originalContent = await readFile(replayPath, "utf-8");
      try {
        const outputPath = await generateOutput(targetSession, targetDir);
        return c.json({ path: outputPath });
      } finally {
        await writeFile(replayPath, originalContent, "utf-8");
      }
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // Check existing GitHub export files (requires slug)
  app.get("/api/export/github/status", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    const targetDir = join(baseDir, result.slug);
    try {
      await loadSession(result.slug, targetId);
      const svgPath = join(targetDir, "session-preview.svg");
      const mdPath = join(targetDir, "github-summary.md");
      const gifPath = join(targetDir, "session-preview.gif");
      const [svgContent, markdown, gifBuf] = await Promise.all([
        readFile(svgPath, "utf-8").catch(() => null),
        readFile(mdPath, "utf-8").catch(() => null),
        readFile(gifPath).catch(() => null),
      ]);
      if (!svgContent && !markdown && !gifBuf) return c.json({ exists: false });
      const gist = await loadSavedGistInfo(targetDir);
      const gifContent = gifBuf ? gifBuf.toString("base64") : null;
      // Get file modification times for "last generated" display
      const [gifMtime, svgMtime, mdMtime] = await Promise.all([
        stat(gifPath)
          .then((s) => s.mtime.toISOString())
          .catch(() => null),
        stat(svgPath)
          .then((s) => s.mtime.toISOString())
          .catch(() => null),
        stat(mdPath)
          .then((s) => s.mtime.toISOString())
          .catch(() => null),
      ]);
      return c.json({
        exists: true,
        svgContent,
        markdown,
        svgPath,
        mdPath,
        gifContent,
        gifPath,
        gifGeneratedAt: gifMtime,
        svgGeneratedAt: svgMtime,
        mdGeneratedAt: mdMtime,
        replayUrl: gist?.viewerUrl || undefined,
      });
    } catch {
      return c.json({ exists: false });
    }
  });

  // Export GitHub markdown + SVG + GIF (requires slug)
  app.post("/api/export/github", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetId = safeTargetId(c.req.query("targetId"));
    if (targetId === null) return c.json({ error: "invalid targetId" }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSession(result.slug, targetId);
      const overlaysData = await loadOverlays(baseDir, result.slug, targetId);
      const targetSession = sessionForExternalOutput(
        sessionWithEffectiveContent(rawSession, overlaysData),
      );

      // Check for a previously published gist to use as replay URL
      const gist = await loadSavedGistInfo(targetDir);
      const replayUrl = gist?.viewerUrl || undefined;

      // Generate SVG
      const svgContent = generateGitHubSvg(targetSession, { replayUrl });
      const svgFilePath = join(targetDir, "session-preview.svg");
      await writeFile(svgFilePath, svgContent, "utf-8");

      // Generate GIF
      let gifContent: string | null = null;
      let gifFilePath: string | null = null;
      let gifWarning: string | undefined;
      try {
        const gifBuffer = await generateGitHubGif(targetSession, { replayUrl });
        gifFilePath = join(targetDir, "session-preview.gif");
        await writeFile(gifFilePath, gifBuffer);
        gifContent = gifBuffer.toString("base64");
      } catch (err) {
        // GIF generation is best-effort — SVG still works
        gifWarning = `GIF generation failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Generate markdown (prefer GIF for universal GitHub support)
      const markdown = generateGitHubMarkdown(targetSession, {
        replayUrl,
        svgPath: "./session-preview.svg",
        gifPath: gifContent ? "./session-preview.gif" : undefined,
      });
      const mdFilePath = join(targetDir, "github-summary.md");
      await writeFile(mdFilePath, markdown, "utf-8");

      // Secret scan warnings
      const findings = scanForSecrets(JSON.stringify(targetSession));
      const warnings = findings.map((f) => `[${f.rule}] ${f.match}`);

      const now = new Date().toISOString();
      return c.json({
        markdown,
        svgContent,
        svgPath: svgFilePath,
        mdPath: mdFilePath,
        gifContent,
        gifPath: gifFilePath,
        gifGeneratedAt: gifContent ? now : undefined,
        gifWarning,
        svgGeneratedAt: now,
        mdGeneratedAt: now,
        replayUrl,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });
}
