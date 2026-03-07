import { createServer } from "node:net";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import open from "open";
import chalk from "chalk";
import type { ReplaySession, Annotation } from "./types.js";
import { generateOutput } from "./generator.js";
import { checkGhStatus, publishGist, loadSavedGistInfo, type SavedGistInfo } from "./publishers/gist.js";
import { detectFeedbackTools, generateFeedback } from "./feedback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

async function loadViewerHtml(): Promise<string> {
  const assetsPaths = [
    join(__dirname, "..", "assets", "viewer.html"),
    join(__dirname, "assets", "viewer.html"),
    join(__dirname, "..", "..", "assets", "viewer.html"),
  ];
  for (const p of assetsPaths) {
    try {
      return await readFile(p, "utf-8");
    } catch {
      continue;
    }
  }
  throw new Error("Could not find viewer.html. Run `pnpm build` first.");
}

/** Scan replay.json files from a single directory */
async function scanSessionsFromDir(baseDir: string): Promise<any[]> {
  const results: any[] = [];
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const replayPath = join(baseDir, entry, "replay.json");
    try {
      const raw = await readFile(replayPath, "utf-8");
      const session = JSON.parse(raw) as ReplaySession;
      const annotationsPath = join(baseDir, entry, "annotations.json");
      let annotationCount = 0;
      try {
        const annRaw = await readFile(annotationsPath, "utf-8");
        const anns = JSON.parse(annRaw) as Annotation[];
        annotationCount = Array.isArray(anns) ? anns.length : 0;
      } catch { /* no annotations */ }

      let gist: SavedGistInfo | undefined;
      try {
        gist = await loadSavedGistInfo(join(baseDir, entry));
      } catch { /* no gist info */ }

      const firstPrompt = session.scenes?.find((sc) => sc.type === "user-prompt");
      const firstMessage = firstPrompt?.content?.slice(0, 200) || undefined;

      results.push({
        slug: entry,
        baseDir,
        title: session.meta.title,
        provider: session.meta.provider,
        model: session.meta.model,
        project: session.meta.project,
        startTime: session.meta.startTime,
        endTime: session.meta.endTime,
        stats: session.meta.stats,
        hasAnnotations: annotationCount > 0,
        annotationCount,
        firstMessage,
        gist: gist ? await (async () => {
          let outdated = false;
          try {
            const replayStat = await stat(replayPath);
            outdated = replayStat.mtimeMs > new Date(gist!.updatedAt).getTime();
          } catch { /* ignore */ }
          return { gistId: gist!.gistId, viewerUrl: gist!.viewerUrl, updatedAt: gist!.updatedAt, outdated };
        })() : undefined,
      });
    } catch {
      continue;
    }
  }

  return results;
}

/** Scan replay.json from primary dir (~/.vibe-replay/) + optional CWD fallback (./vibe-replay/) */
async function scanSessions(baseDir: string): Promise<any[]> {
  const dirs = [baseDir];
  // Also scan ./vibe-replay/ in CWD for backwards compatibility
  const cwdLocal = resolve("./vibe-replay");
  if (cwdLocal !== baseDir) {
    dirs.push(cwdLocal);
  }

  const allResults: any[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const results = await scanSessionsFromDir(dir);
    for (const r of results) {
      if (!seen.has(r.slug)) {
        seen.add(r.slug);
        allResults.push(r);
      }
    }
  }

  allResults.sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  return allResults;
}

/** Load a session from disk by slug — checks primary dir then CWD fallback */
async function loadSessionFromDisk(baseDir: string, slug: string): Promise<ReplaySession> {
  let replayPath = join(baseDir, slug, "replay.json");
  try {
    await stat(replayPath);
  } catch {
    // Fallback: try ./vibe-replay/ in CWD
    const fallback = resolve("./vibe-replay", slug, "replay.json");
    await stat(fallback); // throws if not found
    replayPath = fallback;
  }
  const raw = await readFile(replayPath, "utf-8");
  const session = JSON.parse(raw) as ReplaySession;

  const sessionDir = dirname(replayPath);
  const annotationsPath = join(sessionDir, "annotations.json");
  try {
    const annRaw = await readFile(annotationsPath, "utf-8");
    const anns = JSON.parse(annRaw) as Annotation[];
    if (Array.isArray(anns) && anns.length > 0) {
      session.annotations = anns;
    }
  } catch { /* no annotations */ }

  return session;
}

export async function startEditor(
  session: ReplaySession,
  outputDir: string,
  opts?: { openDashboard?: boolean; externalViewerUrl?: string },
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  // Base directory for dashboard (parent of outputDir, e.g. ~/.vibe-replay/)
  const baseDir = dirname(outputDir);
  const currentSlug = outputDir.split("/").pop()!;

  // Load existing annotations from disk
  const annotationsPath = join(outputDir, "annotations.json");
  try {
    const raw = await readFile(annotationsPath, "utf-8");
    const saved = JSON.parse(raw) as Annotation[];
    if (Array.isArray(saved) && saved.length > 0) {
      session = { ...session, annotations: saved };
    }
  } catch { /* no saved annotations */ }

  // In-memory annotations state (for the initially-loaded session)
  let annotations: Annotation[] = session.annotations ?? [];

  const viewerHtml = await loadViewerHtml();

  const app = new Hono();

  // Serve viewer HTML with editor flag
  app.get("/", (c) => {
    const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
    const headIdx = viewerHtml.lastIndexOf("</head>");
    const html = viewerHtml.slice(0, headIdx) + flag + "\n" + viewerHtml.slice(headIdx);
    return c.html(html);
  });

  // --- Session data ---
  // Without slug: returns the current (initially loaded) session
  // With slug: loads any session from disk (for dashboard navigation)
  app.get("/api/session", async (c) => {
    const slug = c.req.query("slug");
    if (!slug || slug === currentSlug) {
      return c.json({ ...session, annotations });
    }
    // Load a different session from disk
    try {
      const other = await loadSessionFromDisk(baseDir, slug);
      return c.json(other);
    } catch {
      return c.json({ error: `Session not found: ${slug}` }, 404);
    }
  });

  // --- Dashboard: list all sessions ---
  app.get("/api/sessions", async (c) => {
    const sessions = await scanSessions(baseDir);
    return c.json(sessions);
  });

  // --- Dashboard: update title ---
  app.patch("/api/sessions/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json<{ title: string }>();
    if (!body.title && body.title !== "") {
      return c.json({ error: "title field required" }, 400);
    }

    try {
      const target = await loadSessionFromDisk(baseDir, slug);
      target.meta.title = body.title || undefined;

      const targetDir = join(baseDir, slug);
      await writeFile(join(targetDir, "replay.json"), JSON.stringify(target), "utf-8");
      await generateOutput(target, targetDir);

      // Update in-memory session if it's the current one
      if (slug === currentSlug) {
        session = { ...session, meta: { ...session.meta, title: target.meta.title } };
      }

      return c.json({ ok: true, title: target.meta.title });
    } catch (err: any) {
      return c.json({ error: err.message || "Update failed" }, 500);
    }
  });

  // --- Dashboard: delete session ---
  app.delete("/api/sessions/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (slug === currentSlug) {
      return c.json({ error: "Cannot delete the currently active session" }, 400);
    }
    try {
      const { rm } = await import("node:fs/promises");
      await rm(join(baseDir, slug), { recursive: true });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message || "Delete failed" }, 500);
    }
  });

  // --- Annotations ---
  // slug query param: operate on a specific session; no slug: current session
  app.get("/api/annotations", async (c) => {
    const slug = c.req.query("slug");
    if (slug && slug !== currentSlug) {
      const annPath = join(baseDir, slug, "annotations.json");
      try {
        const raw = await readFile(annPath, "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json([]);
      }
    }
    return c.json(annotations);
  });

  app.post("/api/annotations", async (c) => {
    const slug = c.req.query("slug");
    const body = await c.req.json<Annotation[]>();

    if (slug && slug !== currentSlug) {
      // Save annotations for a different session
      const annPath = join(baseDir, slug, "annotations.json");
      try {
        await writeFile(annPath, JSON.stringify(body, null, 2), "utf-8");
      } catch { /* ignore */ }
      return c.json({ ok: true });
    }

    // Current session
    annotations = body;
    try {
      await writeFile(annotationsPath, JSON.stringify(annotations, null, 2), "utf-8");
    } catch { /* ignore write errors */ }
    return c.json({ ok: true });
  });

  // GitHub CLI status
  app.get("/api/gh-status", async (c) => {
    const status = await checkGhStatus();
    return c.json(status);
  });

  // Publish to Gist
  app.post("/api/publish/gist", async (c) => {
    const slug = c.req.query("slug");
    const targetSlug = slug || currentSlug;
    const targetDir = join(baseDir, targetSlug);

    try {
      const targetSession = (targetSlug === currentSlug)
        ? { ...session, annotations }
        : await loadSessionFromDisk(baseDir, targetSlug);

      await writeFile(join(targetDir, "replay.json"), JSON.stringify(targetSession), "utf-8");

      const title = targetSession.meta.title || targetSession.meta.slug;
      const savedGist = await loadSavedGistInfo(targetDir);
      const result = await publishGist(targetDir, title, {
        overwrite: savedGist || undefined,
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message || "Gist publish failed" }, 500);
    }
  });

  // Export HTML
  app.post("/api/export/html", async (c) => {
    const slug = c.req.query("slug");
    const targetSlug = slug || currentSlug;
    const targetDir = join(baseDir, targetSlug);

    try {
      const targetSession = (targetSlug === currentSlug)
        ? { ...session, annotations }
        : await loadSessionFromDisk(baseDir, targetSlug);

      const outputPath = await generateOutput(targetSession, targetDir);
      return c.json({ path: outputPath });
    } catch (err: any) {
      return c.json({ error: err.message || "HTML export failed" }, 500);
    }
  });

  // AI Feedback — detect available CLI tools
  app.get("/api/feedback/detect", async (c) => {
    try {
      const detected = await detectFeedbackTools();
      if (detected.tools.length > 0 && detected.defaultTool) {
        return c.json({
          available: true,
          tool: { name: detected.defaultTool.name },
          tools: detected.tools.map((t) => ({ name: t.name })),
          defaultTool: { name: detected.defaultTool.name },
        });
      }
      return c.json({ available: false });
    } catch {
      return c.json({ available: false });
    }
  });

  // AI Feedback — generate feedback annotations
  app.post("/api/feedback/generate", async (c) => {
    const slug = c.req.query("slug");
    const targetSlug = slug || currentSlug;

    try {
      const body = await c.req.json<{ toolName?: string }>().catch(() => ({}));
      const requestedToolName = typeof body.toolName === "string" ? body.toolName : undefined;
      const detected = await detectFeedbackTools();
      if (detected.tools.length === 0) {
        return c.json({ error: "No AI CLI tool available (claude, agent, or opencode)" }, 400);
      }
      const tool = requestedToolName
        ? detected.tools.find((t) => t.name === requestedToolName) || null
        : detected.defaultTool;
      if (!tool) {
        return c.json({ error: `Requested AI Coach tool is not available: ${requestedToolName}` }, 400);
      }

      const targetSession = (targetSlug === currentSlug)
        ? { ...session, annotations }
        : await loadSessionFromDisk(baseDir, targetSlug);

      const fb = await generateFeedback(targetSession, tool);
      if (!fb) {
        return c.json({ error: "Could not generate feedback (invalid AI output)" }, 500);
      }

      const existingAnns = targetSession.annotations ?? [];
      const newAnnotations = [
        ...existingAnns.filter((a) => a.author !== "vibe-feedback"),
        ...fb.annotations,
      ];

      // Update in-memory if current session
      if (targetSlug === currentSlug) {
        annotations = newAnnotations;
      }

      // Persist
      const annPath = join(baseDir, targetSlug, "annotations.json");
      try {
        await writeFile(annPath, JSON.stringify(newAnnotations, null, 2), "utf-8");
      } catch { /* ignore */ }

      return c.json({
        annotations: newAnnotations,
        score: fb.result.score,
        itemCount: fb.result.feedbackItems.length,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Feedback generation failed" }, 500);
    }
  });

  const port = await findFreePort(3456, 3466);
  const url = `http://localhost:${port}`;
  const browseUrl = opts?.externalViewerUrl
    ? opts.openDashboard ? `${opts.externalViewerUrl}/?view=dashboard` : opts.externalViewerUrl
    : opts?.openDashboard ? `${url}/?view=dashboard` : url;

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    const label = opts?.openDashboard ? "Dashboard" : "Editor";
    if (opts?.externalViewerUrl) {
      console.log(
        chalk.bold.cyan(`\n  ${label} API running on port ${port}`) +
          chalk.dim(" → ") +
          chalk.white(browseUrl) +
          chalk.dim("\n  Press Ctrl+C to stop\n"),
      );
    } else {
      console.log(
        chalk.bold.cyan(`\n  ${label} running at `) +
          chalk.white(browseUrl) +
          chalk.dim("\n  Press Ctrl+C to stop\n"),
      );
    }
    open(browseUrl);
  });

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log(chalk.dim("\n  Editor stopped.\n"));
      resolve();
      process.exit(0);
    });
  });
}

/**
 * Start dashboard mode — finds first existing replay and opens dashboard view.
 */
export async function startDashboard(baseDir: string, opts?: { externalViewerUrl?: string }): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  // Find first replay to use as the "current" session
  const sessions = await scanSessions(baseDir);
  if (sessions.length === 0) {
    console.log(chalk.red("  No replays found in " + baseDir));
    console.log(chalk.dim("  Run vibe-replay first to create a replay.\n"));
    process.exit(1);
  }

  const firstSlug = sessions[0].slug;
  const session = await loadSessionFromDisk(baseDir, firstSlug);
  const outputDir = join(baseDir, firstSlug);

  await startEditor(session, outputDir, { openDashboard: true, externalViewerUrl: opts?.externalViewerUrl });
}
