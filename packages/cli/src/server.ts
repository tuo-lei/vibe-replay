import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import open from "open";
import chalk from "chalk";
import type { ReplaySession, Annotation } from "./types.js";
import { generateOutput } from "./generator.js";
import { checkGhStatus, publishGist, loadSavedGistInfo } from "./publishers/gist.js";
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

export async function startEditor(
  session: ReplaySession,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  // Load existing annotations from disk
  const annotationsPath = join(outputDir, "annotations.json");
  try {
    const raw = await readFile(annotationsPath, "utf-8");
    const saved = JSON.parse(raw) as Annotation[];
    if (Array.isArray(saved) && saved.length > 0) {
      session = { ...session, annotations: saved };
    }
  } catch { /* no saved annotations */ }

  // In-memory annotations state
  let annotations: Annotation[] = session.annotations ?? [];

  const viewerHtml = await loadViewerHtml();

  const app = new Hono();

  // Serve viewer HTML (without embedded data — viewer fetches from API)
  app.get("/", (c) => {
    // Inject editor flag before </head>
    const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
    const headIdx = viewerHtml.lastIndexOf("</head>");
    const html = viewerHtml.slice(0, headIdx) + flag + "\n" + viewerHtml.slice(headIdx);
    return c.html(html);
  });

  // Session data
  app.get("/api/session", (c) => {
    return c.json({ ...session, annotations });
  });

  // Annotations CRUD
  app.get("/api/annotations", (c) => {
    return c.json(annotations);
  });

  app.post("/api/annotations", async (c) => {
    const body = await c.req.json<Annotation[]>();
    annotations = body;
    // Persist to disk
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
    try {
      // Write replay.json with current annotations before publishing
      const replayWithAnnotations = { ...session, annotations };
      const jsonPath = join(outputDir, "replay.json");
      await writeFile(jsonPath, JSON.stringify(replayWithAnnotations), "utf-8");

      const title = session.meta.title || session.meta.slug;
      const savedGist = await loadSavedGistInfo(outputDir);
      const result = await publishGist(outputDir, title, {
        overwrite: savedGist || undefined,
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message || "Gist publish failed" }, 500);
    }
  });

  // Export HTML
  app.post("/api/export/html", async (c) => {
    try {
      const replayWithAnnotations = { ...session, annotations };
      const outputPath = await generateOutput(replayWithAnnotations, outputDir);
      return c.json({ path: outputPath });
    } catch (err: any) {
      return c.json({ error: err.message || "HTML export failed" }, 500);
    }
  });

  // AI Feedback — detect available CLI tools
  app.get("/api/feedback/detect", async (c) => {
    try {
      const tool = await detectFeedbackTools();
      if (tool) {
        return c.json({ available: true, tool: { name: tool.name } });
      }
      return c.json({ available: false });
    } catch {
      return c.json({ available: false });
    }
  });

  // AI Feedback — generate feedback annotations
  app.post("/api/feedback/generate", async (c) => {
    try {
      const tool = await detectFeedbackTools();
      if (!tool) {
        return c.json({ error: "No AI CLI tool available (claude or opencode)" }, 400);
      }
      const fb = await generateFeedback({ ...session, annotations }, tool);
      if (!fb) {
        return c.json({ error: "Could not generate feedback (invalid AI output)" }, 500);
      }
      // Replace any previous vibe-feedback annotations and merge new ones
      annotations = [
        ...annotations.filter((a) => a.author !== "vibe-feedback"),
        ...fb.annotations,
      ];
      // Persist to disk
      try {
        await writeFile(annotationsPath, JSON.stringify(annotations, null, 2), "utf-8");
      } catch { /* ignore write errors */ }
      return c.json({
        annotations,
        score: fb.result.score,
        itemCount: fb.result.feedbackItems.length,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Feedback generation failed" }, 500);
    }
  });

  const port = await findFreePort(3456, 3466);
  const url = `http://localhost:${port}`;

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(
      chalk.bold.cyan("\n  Editor running at ") +
        chalk.white(url) +
        chalk.dim("\n  Press Ctrl+C to stop\n"),
    );
    open(url);
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
