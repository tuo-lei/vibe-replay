import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import chalk from "chalk";
import { Hono } from "hono";
import open from "open";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText } from "./clean-prompt.js";
import { detectFeedbackTools, generateFeedback } from "./feedback.js";
import { generateGitHubMarkdown, generateGitHubSvg } from "./formatters/github.js";
import { generateOutput } from "./generator.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import {
  checkGhStatus,
  loadSavedGistInfo,
  publishGist,
  type SavedGistInfo,
} from "./publishers/gist.js";
import { scanForSecrets } from "./scan.js";
import { transformToReplay } from "./transform.js";
import type { Annotation, ReplaySession, SessionInfo } from "./types.js";
import { CLI_VERSION } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Sanitize slug to prevent path traversal — rejects anything that isn't a simple name */
function safeSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  const clean = basename(raw);
  if (!clean || clean !== raw || clean === "." || clean === "..") return null;
  return clean;
}

/** Require a valid slug from query param, returning 400 if missing */
function requireSlug(raw: string | undefined): { slug: string } | { error: string } {
  const slug = safeSlug(raw);
  if (!slug) return { error: "slug parameter is required" };
  return { slug };
}

const MAX_TITLE_CHARS = 120;

function normalizeTitle(title: string): string | undefined {
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  return cleaned || undefined;
}

// ─── Archive helpers (directory-based, one marker file per slug) ────

const ARCHIVE_DIR = ".archive";

async function getArchivedSlugs(baseDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(baseDir, ARCHIVE_DIR));
    return new Set(entries);
  } catch {
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

async function loadViewerHtml(): Promise<string> {
  const assetsPaths = [
    join(__dirname, "..", "assets", "viewer.html"),
    join(__dirname, "assets", "viewer.html"),
    join(__dirname, "..", "..", "assets", "viewer.html"),
  ];
  for (const p of assetsPaths) {
    try {
      return await readFile(p, "utf-8");
    } catch {}
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
      } catch {
        /* no annotations */
      }

      let gist: SavedGistInfo | undefined;
      try {
        gist = await loadSavedGistInfo(join(baseDir, entry));
      } catch {
        /* no gist info */
      }

      const userPrompts = (session.scenes || [])
        .filter((sc) => sc.type === "user-prompt")
        .map((sc) => cleanPromptText(sc.content).slice(0, 200))
        .filter((m) => m.length >= 10);
      const firstMessage = userPrompts[0] || undefined;
      const messages = userPrompts.length > 0 ? userPrompts.slice(0, 2) : undefined;

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
        messages,
        gist: gist
          ? await (async () => {
              let outdated = false;
              if (gist?.contentHash) {
                try {
                  const content = await readFile(replayPath, "utf-8");
                  const currentHash = createHash("sha256")
                    .update(content)
                    .digest("hex")
                    .slice(0, 16);
                  outdated = currentHash !== gist?.contentHash;
                } catch {
                  /* ignore */
                }
              }
              return {
                gistId: gist?.gistId,
                viewerUrl: gist?.viewerUrl,
                updatedAt: gist?.updatedAt,
                outdated,
              };
            })()
          : undefined,
      });
    } catch {}
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
  } catch {
    /* no annotations */
  }

  return session;
}

/**
 * Merge multiple JSONL files that share the same slug + project into one entry.
 * Claude Code creates a new file per /resume, but they're the same logical session.
 */
function mergeSameSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = `${s.project}::${s.slug}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(s);
  }

  const result: SessionInfo[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    group.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latest = group[0];
    const allPaths = group
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .flatMap((s) => s.filePaths);

    result.push({
      ...latest,
      lineCount: group.reduce((sum, s) => sum + s.lineCount, 0),
      fileSize: group.reduce((sum, s) => sum + s.fileSize, 0),
      filePaths: allPaths,
      toolPaths: [...new Set(group.flatMap((s) => s.toolPaths || []))],
    });
  }

  result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return result;
}

/** Load annotations from disk for a given slug */
async function loadAnnotations(baseDir: string, slug: string): Promise<Annotation[]> {
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
async function saveAnnotations(
  baseDir: string,
  slug: string,
  annotations: Annotation[],
): Promise<void> {
  const annPath = join(baseDir, slug, "annotations.json");
  await writeFile(annPath, JSON.stringify(annotations, null, 2), "utf-8");
}

export async function startServer(
  baseDir: string,
  opts?: {
    openDashboard?: boolean;
    openSlug?: string;
    externalViewerUrl?: string;
  },
): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const viewerHtml = await loadViewerHtml();
  const cacheKeySuffix = createHash("sha1").update(baseDir).digest("hex").slice(0, 12);
  const sourcesCacheKey = `dashboard-sources-v1-${cacheKeySuffix}`;
  const replaysCacheKey = `dashboard-replays-v1-${cacheKeySuffix}`;
  const refreshReplaysCache = async (): Promise<void> => {
    try {
      const sessions = await scanSessions(baseDir);
      await writeFileCache(replaysCacheKey, sessions);
    } catch {
      // Best-effort cache refresh for dashboard listing.
    }
  };

  const app = new Hono();

  // Serve viewer HTML with editor flag
  app.get("/", (c) => {
    const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
    const headIdx = viewerHtml.lastIndexOf("</head>");
    const html = `${viewerHtml.slice(0, headIdx) + flag}\n${viewerHtml.slice(headIdx)}`;
    return c.html(html);
  });

  // --- Session data (requires slug) ---
  app.get("/api/session", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    try {
      const session = await loadSessionFromDisk(baseDir, result.slug);
      return c.json(session);
    } catch {
      return c.json({ error: `Session not found: ${result.slug}` }, 404);
    }
  });

  // --- Dashboard: list all sessions ---
  app.get("/api/sessions/cached", async (c) => {
    const cached = await readFileCache<any[]>(replaysCacheKey);
    return c.json({
      sessions: cached?.data || [],
      cachedAt: cached?.updatedAt,
    });
  });

  app.get("/api/sessions", async (c) => {
    const sessions = await scanSessions(baseDir);
    await writeFileCache(replaysCacheKey, sessions);
    return c.json(sessions);
  });

  // --- Dashboard: update title ---
  app.patch("/api/sessions/:slug", async (c) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);

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
      const target = await loadSessionFromDisk(baseDir, slug);
      target.meta.title = normalizeTitle(body.title);

      const targetDir = join(baseDir, slug);
      await writeFile(join(targetDir, "replay.json"), JSON.stringify(target), "utf-8");
      await generateOutput(target, targetDir);
      await refreshReplaysCache();

      return c.json({ ok: true, title: target.meta.title });
    } catch (err: any) {
      return c.json({ error: err.message || "Update failed" }, 500);
    }
  });

  // --- Dashboard: delete session ---
  app.delete("/api/sessions/:slug", async (c) => {
    const slug = safeSlug(c.req.param("slug"));
    if (!slug) return c.json({ error: "invalid slug" }, 400);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(join(baseDir, slug), { recursive: true });
      await refreshReplaysCache();
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message || "Delete failed" }, 500);
    }
  });

  // --- Archive: directory-based, one marker file per slug ---
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

  // --- Sources: discover AI coding sessions from all providers ---
  app.get("/api/sources/cached", async (c) => {
    const cached = await readFileCache<any[]>(sourcesCacheKey);
    return c.json({
      sessions: cached?.data || [],
      cachedAt: cached?.updatedAt,
    });
  });

  app.get("/api/sources", async (c) => {
    try {
      const providers = getAllProviders();
      const allSessions: SessionInfo[] = [];
      for (const provider of providers) {
        const sessions = await provider.discover();
        allSessions.push(...sessions);
      }

      // Merge multi-file sessions (Claude Code /resume creates new JSONL files)
      const merged = mergeSameSessions(allSessions);

      // Normalize project paths: /Users/xxx/... → ~/...
      const home = homedir();
      for (const s of merged) {
        if (s.project.startsWith(home)) {
          s.project = `~${s.project.slice(home.length)}`;
        }
      }

      // Check which project directories still exist on disk + are git repos
      const uniqueProjects = [...new Set(merged.map((s) => s.project))];
      const projectExistsMap = new Map<string, boolean>();
      const projectIsGitMap = new Map<string, boolean>();
      for (const p of uniqueProjects) {
        const resolved = p.startsWith("~/") ? join(home, p.slice(2)) : p === "~" ? home : p;
        try {
          const s = await stat(resolved);
          projectExistsMap.set(p, s.isDirectory());
          if (s.isDirectory()) {
            try {
              await stat(join(resolved, ".git"));
              projectIsGitMap.set(p, true);
            } catch {
              projectIsGitMap.set(p, false);
            }
          }
        } catch {
          projectExistsMap.set(p, false);
        }
      }

      // Check which source sessions already have replays
      const existingReplays = await scanSessions(baseDir);
      const replayMap = new Map<string, any>();
      for (const r of existingReplays) {
        replayMap.set(r.slug as string, r);
      }

      const result = merged.map((s) => {
        const replay = replayMap.get(s.slug);
        return {
          provider: s.provider,
          slug: s.slug,
          title: s.title,
          project: s.project,
          timestamp: s.timestamp,
          fileSize: s.fileSize,
          lineCount: s.lineCount,
          firstPrompt: cleanPromptText(s.firstPrompt).slice(0, 200),
          prompts: s.prompts?.map((p) => cleanPromptText(p).slice(0, 200)),
          filePaths: s.filePaths,
          toolPaths: s.toolPaths,
          hasSqlite: s.hasSqlite,
          gitBranch: s.gitBranch,
          existingReplay: replay ? s.slug : null,
          projectExists: projectExistsMap.get(s.project) ?? false,
          isGitRepo: projectIsGitMap.get(s.project) ?? false,
          replay: replay
            ? {
                slug: replay.slug,
                title: replay.title,
                provider: replay.provider,
                model: replay.model,
                project: replay.project,
                startTime: replay.startTime,
                endTime: replay.endTime,
                stats: replay.stats,
                hasAnnotations: replay.hasAnnotations,
                annotationCount: replay.annotationCount,
                firstMessage: replay.firstMessage,
                messages: replay.messages,
                gist: replay.gist,
              }
            : undefined,
        };
      });

      await writeFileCache(sourcesCacheKey, result);
      return c.json({ sessions: result });
    } catch (err: any) {
      return c.json({ error: err.message || "Source discovery failed" }, 500);
    }
  });

  // --- Generate: parse a source session into a replay ---
  app.post("/api/generate", async (c) => {
    try {
      const body = await c.req.json<{
        provider: string;
        filePaths: string[];
        toolPaths?: string[];
        title?: unknown;
        sessionSlug?: string;
        sessionProject?: string;
      }>();

      const provider = getProvider(body.provider);
      if (!provider) {
        return c.json({ error: `Unknown provider: ${body.provider}` }, 400);
      }

      const paths = [...body.filePaths, ...(body.toolPaths || [])];
      if (paths.length === 0) {
        return c.json({ error: "filePaths is required" }, 400);
      }
      if (body.title !== undefined && typeof body.title !== "string") {
        return c.json({ error: "title must be a string" }, 400);
      }

      const parsed = await provider.parse(paths);

      const home = homedir();
      const rawProject = body.sessionProject || parsed.cwd;
      const project = rawProject.startsWith(home)
        ? `~${rawProject.slice(home.length)}`
        : rawProject;

      const replay = transformToReplay(parsed, body.provider, project, {
        generator: {
          name: "vibe-replay",
          version: CLI_VERSION,
          generatedAt: new Date().toISOString(),
        },
      });

      if (typeof body.title === "string") {
        const normalizedCustomTitle = normalizeTitle(body.title);
        if (normalizedCustomTitle) {
          replay.meta.title = normalizedCustomTitle;
        }
      }

      // Save replay
      const rawSlug = replay.meta.slug || replay.meta.sessionId.slice(0, 8);
      const slug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-");
      const outputDir = join(baseDir, slug);
      await generateOutput(replay, outputDir);
      await refreshReplaysCache();

      // Secret scanning
      const findings = scanForSecrets(JSON.stringify(replay));
      const warnings = findings.map((f) => `[${f.rule}] ${f.match}`);

      return c.json({
        slug,
        title: replay.meta.title || slug,
        sceneCount: replay.scenes.length,
        stats: {
          userPrompts: replay.meta.stats.userPrompts,
          toolCalls: replay.meta.stats.toolCalls,
          thinkingBlocks: replay.meta.stats.thinkingBlocks,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Generation failed" }, 500);
    }
  });

  // --- Annotations (requires slug) ---
  app.get("/api/annotations", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const anns = await loadAnnotations(baseDir, result.slug);
    return c.json(anns);
  });

  app.post("/api/annotations", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    let body: Annotation[];
    try {
      body = await c.req.json<Annotation[]>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      await saveAnnotations(baseDir, result.slug, body);
    } catch {
      /* ignore */
    }
    return c.json({ ok: true });
  });

  // GitHub CLI status
  app.get("/api/gh-status", async (c) => {
    const status = await checkGhStatus();
    return c.json(status);
  });

  // Publish to Gist (requires slug)
  app.post("/api/publish/gist", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const targetSession = await loadSessionFromDisk(baseDir, result.slug);

      await writeFile(join(targetDir, "replay.json"), JSON.stringify(targetSession), "utf-8");

      const title = targetSession.meta.title || targetSession.meta.slug;
      const savedGist = await loadSavedGistInfo(targetDir);
      const gistResult = await publishGist(targetDir, title, {
        overwrite: savedGist || undefined,
      });
      return c.json(gistResult);
    } catch (err: any) {
      return c.json({ error: err.message || "Gist publish failed" }, 500);
    }
  });

  // Export HTML (requires slug)
  app.post("/api/export/html", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const targetSession = await loadSessionFromDisk(baseDir, result.slug);
      const outputPath = await generateOutput(targetSession, targetDir);
      return c.json({ path: outputPath });
    } catch (err: any) {
      return c.json({ error: err.message || "HTML export failed" }, 500);
    }
  });

  // Export GitHub markdown + SVG (requires slug)
  app.post("/api/export/github", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const targetSession = await loadSessionFromDisk(baseDir, result.slug);

      // Check for a previously published gist to use as replay URL
      const gist = await loadSavedGistInfo(targetDir);
      const replayUrl = gist?.viewerUrl || undefined;

      // Generate SVG
      const svgContent = generateGitHubSvg(targetSession, { replayUrl });
      const svgFilePath = join(targetDir, "session-preview.svg");
      await writeFile(svgFilePath, svgContent, "utf-8");

      // Generate markdown
      const markdown = generateGitHubMarkdown(targetSession, {
        replayUrl,
        svgPath: "./session-preview.svg",
      });
      const mdFilePath = join(targetDir, "github-summary.md");
      await writeFile(mdFilePath, markdown, "utf-8");

      // Secret scan warnings
      const findings = scanForSecrets(JSON.stringify(targetSession));
      const warnings = findings.map((f) => `[${f.rule}] ${f.match}`);

      return c.json({
        markdown,
        svgPath: svgFilePath,
        mdPath: mdFilePath,
        replayUrl,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "GitHub export failed" }, 500);
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

  // AI Feedback — generate feedback annotations (requires slug)
  app.post("/api/feedback/generate", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);

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
        return c.json(
          { error: `Requested AI Coach tool is not available: ${requestedToolName}` },
          400,
        );
      }

      const targetSession = await loadSessionFromDisk(baseDir, result.slug);

      const fb = await generateFeedback(targetSession, tool);
      if (!fb) {
        return c.json({ error: "Could not generate feedback (invalid AI output)" }, 500);
      }

      const existingAnns = targetSession.annotations ?? [];
      const newAnnotations = [
        ...existingAnns.filter((a) => a.author !== "vibe-feedback"),
        ...fb.annotations,
      ];

      // Persist
      try {
        await saveAnnotations(baseDir, result.slug, newAnnotations);
      } catch {
        /* ignore */
      }

      return c.json({
        annotations: newAnnotations,
        score: fb.result.score,
        itemCount: fb.result.feedbackItems.length,
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Feedback generation failed" }, 500);
    }
  });

  // Dev mode: fixed port 13456 to match Vite proxy config
  // Production: port 0 lets the OS pick a free port (no conflicts)
  const requestedPort = opts?.externalViewerUrl ? 13456 : 0;

  const _server = serve(
    { fetch: app.fetch, port: requestedPort, hostname: "127.0.0.1" },
    (info) => {
      const port = info.port;
      const url = `http://localhost:${port}`;

      // Build the URL to open in the browser
      let browseUrl: string;
      const viewerBase = opts?.externalViewerUrl || url;
      if (opts?.openDashboard) {
        browseUrl = `${viewerBase}/?view=dashboard`;
      } else if (opts?.openSlug) {
        browseUrl = `${viewerBase}/?session=${encodeURIComponent(opts.openSlug)}`;
      } else {
        browseUrl = `${viewerBase}/?view=dashboard`;
      }

      const label = opts?.openDashboard || !opts?.openSlug ? "Dashboard" : "Editor";
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
    },
  );

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log(chalk.dim("\n  Server stopped.\n"));
      resolve();
      process.exit(0);
    });
  });
}

/**
 * Start dashboard mode — no existing replays required.
 */
export async function startDashboard(
  baseDir: string,
  opts?: { externalViewerUrl?: string },
): Promise<void> {
  await startServer(baseDir, { openDashboard: true, externalViewerUrl: opts?.externalViewerUrl });
}
