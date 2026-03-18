import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import chalk from "chalk";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import open from "open";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText } from "./clean-prompt.js";
import {
  detectFeedbackTools,
  generateFeedback,
  generateToneAdjustment,
  generateTranslation,
} from "./feedback.js";
import { generateGitHubGif } from "./formatters/gif.js";
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
import type {
  Annotation,
  ParsedTurn,
  ReplaySession,
  SessionInfo,
  SessionOverlays,
} from "./types.js";
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

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

const MAX_TITLE_CHARS = 120;

function normalizeTitle(title: string): string | undefined {
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  return cleaned || undefined;
}

function normalizeProjectPath(project: string): string {
  const home = homedir();
  return project.startsWith(home) ? `~${project.slice(home.length)}` : project;
}

interface GenerateRequestBody {
  provider: string;
  filePaths?: unknown;
  toolPaths?: unknown;
  title?: unknown;
  sessionSlug?: string;
  sessionProject?: string;
  sessionId?: string;
}

interface ResolvedGenerateInputs {
  paths: string[];
  sessionInfo?: SessionInfo;
}

type GenerateInputResolution =
  | { ok: true; value: ResolvedGenerateInputs }
  | { ok: false; error: string };

function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== "string")) return null;
  return value;
}

export function resolveGenerateInputs(
  body: GenerateRequestBody,
  discoveredSessions: SessionInfo[],
): GenerateInputResolution {
  const filePaths = toStringArray(body.filePaths);
  if (!filePaths) {
    return { ok: false, error: "filePaths must be an array of strings" };
  }
  const toolPaths = toStringArray(body.toolPaths);
  if (!toolPaths) {
    return { ok: false, error: "toolPaths must be an array of strings" };
  }

  const requestedSessionSlug =
    typeof body.sessionSlug === "string" ? safeSlug(body.sessionSlug) : null;
  const requestedSessionProject =
    typeof body.sessionProject === "string" ? normalizeProjectPath(body.sessionProject) : undefined;

  let sessionInfo: SessionInfo | undefined;
  if (requestedSessionSlug) {
    const slugMatches = discoveredSessions.filter((s) => s.slug === requestedSessionSlug);
    if (requestedSessionProject) {
      sessionInfo = slugMatches.find(
        (s) => normalizeProjectPath(s.project) === requestedSessionProject,
      );
    }
    sessionInfo = sessionInfo || slugMatches[0];
  }
  // Fallback: match by sessionId (covers old JSONL files where slug differs from replay slug)
  if (!sessionInfo && typeof body.sessionId === "string" && body.sessionId) {
    sessionInfo = discoveredSessions.find((s) => s.sessionId === body.sessionId);
  }

  const fallbackFilePaths = sessionInfo?.filePaths || [];
  const fallbackToolPaths = sessionInfo?.toolPaths || [];
  const paths = [
    ...(filePaths.length > 0 ? filePaths : fallbackFilePaths),
    ...(toolPaths.length > 0 ? toolPaths : fallbackToolPaths),
  ];

  const hasCursorSessionFallback = body.provider === "cursor" && Boolean(sessionInfo?.sessionId);
  if (paths.length === 0 && !hasCursorSessionFallback) {
    return {
      ok: false,
      error:
        "filePaths is required (or provide a resolvable Cursor sessionSlug for SQLite/global-state sessions)",
    };
  }

  return {
    ok: true,
    value: {
      paths,
      sessionInfo,
    },
  };
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
        sessionId: session.meta.sessionId,
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

interface SourceSummaryRecord {
  provider: string;
  slug: string;
  project: string;
  sessionId?: string;
  promptCount?: number;
  toolCallCount?: number;
  filePaths: string[];
  toolPaths?: string[];
  hasSqlite?: boolean;
  timestamp: string;
  [key: string]: unknown;
}

interface SourcesEnrichmentStatus {
  running: boolean;
  processed: number;
  total: number;
  updated: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

function sourceSessionKey(provider: string, project: string, slug: string): string {
  return `${provider}::${project}::${slug}`;
}

function pickSourceRecordForSession(
  session: Pick<SessionInfo, "provider" | "sessionId" | "project" | "slug">,
  bySessionId: Map<string, SourceSummaryRecord>,
  byKey: Map<string, SourceSummaryRecord>,
): SourceSummaryRecord | undefined {
  const byIdMatch = bySessionId.get(session.sessionId);
  return (
    (byIdMatch?.provider === session.provider ? byIdMatch : undefined) ??
    byKey.get(sourceSessionKey(session.provider, session.project, session.slug))
  );
}

function selectCursorEnrichmentCandidates(
  merged: SessionInfo[],
  baseSources: SourceSummaryRecord[],
  limit = 30,
): SessionInfo[] {
  const mergedBySessionId = new Map<string, SessionInfo>();
  const mergedByKey = new Map<string, SessionInfo>();
  for (const session of merged) {
    mergedBySessionId.set(session.sessionId, session);
    mergedByKey.set(sourceSessionKey(session.provider, session.project, session.slug), session);
  }

  return baseSources
    .filter(
      (s) =>
        s.provider === "cursor" &&
        (s.promptCount == null || s.toolCallCount == null) &&
        (s.hasSqlite || s.filePaths.length > 0),
    )
    .map((s) => {
      const byId = s.sessionId ? mergedBySessionId.get(s.sessionId) : undefined;
      return byId || mergedByKey.get(sourceSessionKey(s.provider, s.project, s.slug));
    })
    .filter((s): s is SessionInfo => Boolean(s))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

function countSessionStats(turns: ParsedTurn[]): {
  promptCount: number;
  toolCallCount: number;
} {
  let promptCount = 0;
  let toolCallCount = 0;
  for (const turn of turns) {
    if (turn.role === "user" && turn.subtype !== "compaction-summary") {
      const hasText = turn.blocks.some(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
      );
      const hasImages = turn.blocks.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type?: unknown }).type === "_user_images" &&
          "images" in block &&
          Array.isArray((block as { images?: unknown }).images) &&
          (block as { images: unknown[] }).images.length > 0,
      );
      if (hasText || hasImages) promptCount++;
    }
    for (const block of turn.blocks) {
      if (block.type === "tool_use") toolCallCount++;
    }
  }
  return { promptCount, toolCallCount };
}

/**
 * Merge multiple JSONL files that share the same slug + project into one entry.
 * Claude Code creates a new file per /resume, but they're the same logical session.
 */
/** Shared post-processing for /api/sources and /api/sources/stream:
 *  normalizes project paths, checks directory existence + git status,
 *  looks up existing replays, and maps to the response shape. */
async function buildSourcesResult(
  merged: SessionInfo[],
  baseDir: string,
  home: string,
  previousSources: SourceSummaryRecord[] = [],
): Promise<SourceSummaryRecord[]> {
  // Normalize project paths: /Users/xxx/... → ~/...
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

  const previousBySessionId = new Map<string, SourceSummaryRecord>();
  const previousByKey = new Map<string, SourceSummaryRecord>();
  for (const prev of previousSources) {
    const key = sourceSessionKey(prev.provider, prev.project, prev.slug);
    previousByKey.set(key, prev);
    if (typeof prev.sessionId === "string" && prev.sessionId) {
      previousBySessionId.set(prev.sessionId, prev);
    }
  }

  return merged.map((s) => {
    const previous = pickSourceRecordForSession(s, previousBySessionId, previousByKey);
    const replay = replayMap.get(s.slug);
    const promptCount = s.promptCount ?? previous?.promptCount;
    const toolCallCount = s.toolCallCount ?? previous?.toolCallCount;
    return {
      provider: s.provider,
      sessionId: s.sessionId,
      slug: s.slug,
      title: s.title,
      project: s.project,
      timestamp: s.timestamp,
      fileSize: s.fileSize,
      lineCount: s.lineCount,
      promptCount,
      toolCallCount,
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
            sessionId: replay.sessionId,
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
}

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

    const promptCount = group.some((s) => s.promptCount != null)
      ? group.reduce((sum, s) => sum + (s.promptCount || 0), 0)
      : undefined;
    const toolCallCount = group.some((s) => s.toolCallCount != null)
      ? group.reduce((sum, s) => sum + (s.toolCallCount || 0), 0)
      : undefined;

    result.push({
      ...latest,
      lineCount: group.reduce((sum, s) => sum + s.lineCount, 0),
      fileSize: group.reduce((sum, s) => sum + s.fileSize, 0),
      filePaths: allPaths,
      toolPaths: [...new Set(group.flatMap((s) => s.toolPaths || []))],
      promptCount,
      toolCallCount,
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

// ─── Overlay persistence ────────────────────────────────────────────────────

const EMPTY_OVERLAYS: SessionOverlays = { version: 1, overlays: [] };

async function loadOverlays(baseDir: string, slug: string): Promise<SessionOverlays> {
  const dirs = [join(baseDir, slug), resolve("./vibe-replay", slug)];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, "overlays.json"), "utf-8");
      const parsed = JSON.parse(raw) as SessionOverlays;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.overlays)) {
        return parsed;
      }
    } catch {
      /* not found */
    }
  }
  return EMPTY_OVERLAYS;
}

async function saveOverlays(
  baseDir: string,
  slug: string,
  overlays: SessionOverlays,
): Promise<void> {
  const overlayPath = join(baseDir, slug, "overlays.json");
  await writeFile(overlayPath, JSON.stringify(overlays, null, 2), "utf-8");
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

  const isDevMode = !!opts?.externalViewerUrl;
  // In dev mode, Vite serves the viewer with HMR — no need to load/cache viewer HTML
  const viewerHtml = isDevMode ? "" : await loadViewerHtml();
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
  let sourcesEnrichmentStatus: SourcesEnrichmentStatus = {
    running: false,
    processed: 0,
    total: 0,
    updated: 0,
  };

  const enrichCursorStatsInBackground = (
    merged: SessionInfo[],
    baseSources: SourceSummaryRecord[],
  ): void => {
    if (sourcesEnrichmentStatus.running) return;
    const cursorProvider = getProvider("cursor");
    if (!cursorProvider) return;

    const candidates = selectCursorEnrichmentCandidates(merged, baseSources);

    sourcesEnrichmentStatus = {
      running: true,
      processed: 0,
      total: candidates.length,
      updated: 0,
      startedAt: new Date().toISOString(),
      message:
        candidates.length > 0
          ? "Computing detailed Cursor stats in background"
          : "No Cursor stat backfill needed",
    };

    if (candidates.length === 0) {
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
      };
      return;
    }

    void (async () => {
      let changed = false;
      const enrichedSources = baseSources.map((s) => ({ ...s }));
      const bySessionId = new Map<string, SourceSummaryRecord>();
      const byKey = new Map<string, SourceSummaryRecord>();
      for (const source of enrichedSources) {
        byKey.set(sourceSessionKey(source.provider, source.project, source.slug), source);
        if (typeof source.sessionId === "string" && source.sessionId) {
          bySessionId.set(source.sessionId, source);
        }
      }

      for (const session of candidates) {
        try {
          const paths = [...session.filePaths, ...(session.toolPaths || [])];
          const parsed = await cursorProvider.parse(paths, session);
          const counts = countSessionStats(parsed.turns);
          const target = pickSourceRecordForSession(session, bySessionId, byKey);
          if (
            target &&
            (target.promptCount !== counts.promptCount ||
              target.toolCallCount !== counts.toolCallCount)
          ) {
            target.promptCount = counts.promptCount;
            target.toolCallCount = counts.toolCallCount;
            changed = true;
            sourcesEnrichmentStatus = {
              ...sourcesEnrichmentStatus,
              updated: sourcesEnrichmentStatus.updated + 1,
            };
          }
        } catch {
          // Best-effort enrichment only.
        } finally {
          sourcesEnrichmentStatus = {
            ...sourcesEnrichmentStatus,
            processed: sourcesEnrichmentStatus.processed + 1,
          };
          if (changed && sourcesEnrichmentStatus.processed % 5 === 0) {
            await writeFileCache(sourcesCacheKey, enrichedSources);
          }
        }
      }

      if (changed) {
        await writeFileCache(sourcesCacheKey, enrichedSources);
      }
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
      };
    })().catch(() => {
      sourcesEnrichmentStatus = {
        ...sourcesEnrichmentStatus,
        running: false,
        finishedAt: new Date().toISOString(),
        message: "Cursor stat backfill failed",
      };
    });
  };

  const app = new Hono();

  // Serve viewer HTML with editor flag (prod) or redirect to Vite dev server (dev)
  app.get("/", (c) => {
    if (isDevMode) {
      // In dev mode, redirect to Vite dev server which has HMR
      const viteUrl = new URL(opts!.externalViewerUrl!);
      // Preserve query params (e.g. ?session=xxx, ?view=dashboard)
      const incoming = new URL(c.req.url, "http://localhost");
      viteUrl.search = incoming.search;
      return c.redirect(viteUrl.toString(), 302);
    }
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
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
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
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
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

  app.get("/api/sources/enrichment-status", async (c) => {
    return c.json(sourcesEnrichmentStatus);
  });

  app.get("/api/sources", async (c) => {
    try {
      const providers = getAllProviders();
      const allSessions: SessionInfo[] = [];
      for (const provider of providers) {
        const sessions = await provider.discover();
        allSessions.push(...sessions);
      }

      const merged = mergeSameSessions(allSessions);
      const previous = await readFileCache<SourceSummaryRecord[]>(sourcesCacheKey);
      const result = await buildSourcesResult(merged, baseDir, homedir(), previous?.data || []);

      await writeFileCache(sourcesCacheKey, result);
      enrichCursorStatsInBackground(merged, result);
      return c.json({ sessions: result });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // --- Sources SSE: stream discovery progress to the dashboard ---
  app.get("/api/sources/stream", (c) => {
    return streamSSE(c, async (stream) => {
      try {
        const providers = getAllProviders();
        const allSessions: SessionInfo[] = [];
        let scanned = 0;

        for (const provider of providers) {
          // Quick file count estimate per provider
          const sessions = await provider.discover();
          for (const s of sessions) {
            allSessions.push(s);
            scanned++;
            // Emit progress every 5 sessions to avoid overwhelming the client
            if (scanned % 5 === 0 || scanned === 1) {
              await stream.writeSSE({
                data: JSON.stringify({ type: "progress", scanned }),
              });
            }
          }
        }

        const merged = mergeSameSessions(allSessions);
        const previous = await readFileCache<SourceSummaryRecord[]>(sourcesCacheKey);
        const result = await buildSourcesResult(merged, baseDir, homedir(), previous?.data || []);

        await writeFileCache(sourcesCacheKey, result);
        enrichCursorStatsInBackground(merged, result);
        await stream.writeSSE({
          data: JSON.stringify({ type: "complete", sessions: result }),
        });
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message: getErrorMessage(err) }),
        });
      }
    });
  });

  // --- Generate: parse a source session into a replay ---
  app.post("/api/generate", async (c) => {
    try {
      const body = await c.req.json<GenerateRequestBody>();

      const provider = getProvider(body.provider);
      if (!provider) {
        return c.json({ error: `Unknown provider: ${body.provider}` }, 400);
      }

      let discoveredSessions: SessionInfo[] = [];
      if (typeof body.sessionSlug === "string" && safeSlug(body.sessionSlug)) {
        discoveredSessions = mergeSameSessions(await provider.discover());
      }

      const resolved = resolveGenerateInputs(body, discoveredSessions);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 400);
      }
      if (body.title !== undefined && typeof body.title !== "string") {
        return c.json({ error: "title must be a string" }, 400);
      }

      const parsed = await provider.parse(resolved.value.paths, resolved.value.sessionInfo);

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
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
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

  // Auth — read local auth.json
  const authFilePath = join(homedir(), ".config", "vibe-replay", "auth.json");

  app.get("/api/auth/status", async (c) => {
    try {
      const data = JSON.parse(await readFile(authFilePath, "utf-8"));
      return c.json({ authenticated: true, user: data.user || null });
    } catch {
      return c.json({ authenticated: false, user: null });
    }
  });

  app.post("/api/auth/logout", async (c) => {
    try {
      await unlink(authFilePath);
    } catch {
      // Already gone
    }
    return c.json({ success: true });
  });

  // Auth login — start OAuth flow, return URL for browser to open
  app.post("/api/auth/login", async (c) => {
    const { randomUUID } = await import("node:crypto");
    const http = await import("node:http");

    const apiUrl = (process.env.VIBE_REPLAY_API_URL || "https://vibe-replay.com").replace(
      /\/$/,
      "",
    );
    const nonce = randomUUID();

    // Start a temporary localhost server to receive the OAuth callback
    return new Promise<Response>((resolveResponse) => {
      const server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "POST" && req.url === "/callback") {
          let body = "";
          req.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_000_000) {
              res.writeHead(413);
              res.end();
              req.destroy();
            }
          });
          req.on("end", async () => {
            try {
              const data = JSON.parse(body);
              if (data.nonce !== nonce) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
              }
              res.writeHead(200, {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": "*",
              });
              res.end("OK");

              // Save auth
              const configDir = join(homedir(), ".config", "vibe-replay");
              await mkdir(configDir, { recursive: true, mode: 0o700 });
              await writeFile(authFilePath, JSON.stringify(data, null, 2), {
                mode: 0o600,
              });
            } catch {
              res.writeHead(400);
              res.end("Bad Request");
            }
            server.close();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        const loginUrl = `${apiUrl}/auth/cli-login?port=${addr.port}&nonce=${nonce}`;
        resolveResponse(c.json({ url: loginUrl }));
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          server.close();
        },
        5 * 60 * 1000,
      );
    });
  });

  // System checks — detect available tools for publishing & AI feedback
  app.get("/api/system-checks", async (c) => {
    const exec = promisify(execFile);

    const TOOL_CHECK_TIMEOUT_MS = 3000;
    const CHECK_TIMEOUT_MARKER = "__check_timeout__" as const;
    const CHECK_TIMEOUT_DETAIL = "check timeout";

    interface ToolCheck {
      name: string;
      label: string;
      purpose: string;
      installed: boolean;
      version?: string;
      detail?: string;
    }

    interface CommandRunResult {
      ok: boolean;
      stdout: string;
      timedOut: boolean;
    }

    type ExtraCheckResult = string | typeof CHECK_TIMEOUT_MARKER | undefined;
    type RunCommand = (cmd: string, args: string[]) => Promise<CommandRunResult>;

    function isTimeoutError(err: unknown): boolean {
      if (!(err instanceof Error)) return false;
      const timeoutErr = err as Error & { code?: string; killed?: boolean; signal?: string };
      return (
        timeoutErr.code === "ETIMEDOUT" ||
        timeoutErr.killed === true ||
        timeoutErr.signal === "SIGTERM"
      );
    }

    const runCommand: RunCommand = async (cmd, args) => {
      try {
        const { stdout } = await exec(cmd, args, {
          timeout: TOOL_CHECK_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout, timedOut: false };
      } catch (err) {
        return { ok: false, stdout: "", timedOut: isTimeoutError(err) };
      }
    };

    async function checkCli(
      name: string,
      label: string,
      purpose: string,
      cmd: string,
      versionArgs: string[] = ["--version"],
      extraCheck?: (run: RunCommand) => Promise<ExtraCheckResult>,
    ): Promise<ToolCheck> {
      const whichResult = await runCommand("which", [cmd]);
      if (!whichResult.ok) {
        if (whichResult.timedOut) {
          return { name, label, purpose, installed: false, detail: CHECK_TIMEOUT_DETAIL };
        }
        return { name, label, purpose, installed: false };
      }

      let version: string | undefined;
      const versionResult = await runCommand(cmd, versionArgs);
      if (versionResult.timedOut) {
        return { name, label, purpose, installed: false, detail: CHECK_TIMEOUT_DETAIL };
      }
      if (versionResult.ok) {
        version = versionResult.stdout.trim().split("\n")[0];
      }

      const detail = extraCheck ? await extraCheck(runCommand) : undefined;
      if (detail === CHECK_TIMEOUT_MARKER) {
        return { name, label, purpose, installed: false, version, detail: CHECK_TIMEOUT_DETAIL };
      }

      return { name, label, purpose, installed: true, version, detail };
    }

    const toolChecks: Record<string, () => Promise<ToolCheck>> = {
      gh: () =>
        checkCli(
          "gh",
          "GitHub CLI",
          "Publish replays as GitHub Gists",
          "gh",
          ["--version"],
          async (run) => {
            const auth = await run("gh", ["auth", "status"]);
            if (auth.timedOut) return CHECK_TIMEOUT_MARKER;
            return auth.ok ? "authenticated" : "not authenticated";
          },
        ),
      claude: () =>
        checkCli(
          "claude",
          "Claude Code",
          "AI feedback via headless mode",
          "claude",
          ["--version"],
          async (run) => {
            const auth = await run("claude", ["auth", "status"]);
            if (auth.timedOut) return CHECK_TIMEOUT_MARKER;
            if (!auth.ok) return "not logged in";

            try {
              const info = JSON.parse(auth.stdout) as {
                loggedIn?: boolean;
                email?: string;
                authMethod?: string;
              };
              if (info.loggedIn) return `${info.email || info.authMethod || "logged in"}`;
            } catch {
              // Non-JSON output still means command completed; keep non-blocking fallback detail.
            }

            return "not logged in";
          },
        ),
      cursor: () =>
        checkCli("cursor", "Cursor CLI", "AI feedback via AI Studio", "cursor", [
          "agent",
          "--version",
        ]),
      opencode: () =>
        checkCli(
          "opencode",
          "OpenCode",
          "AI feedback via headless mode",
          "opencode",
          ["--version"],
          async (run) => {
            const auth = await run("opencode", ["auth", "list"]);
            if (auth.timedOut) return CHECK_TIMEOUT_MARKER;
            if (!auth.ok) return undefined;
            return auth.stdout.includes("0 credentials") ? "no credentials" : "configured";
          },
        ),
    };

    const requestedTool = c.req.query("tool");
    if (requestedTool) {
      const checker = toolChecks[requestedTool];
      if (!checker) return c.json({ error: `Unknown tool: ${requestedTool}` }, 400);
      const check = await checker();
      return c.json({ checks: [check] });
    }

    const checks = await Promise.all(Object.values(toolChecks).map((check) => check()));

    return c.json({ checks });
  });

  // Gist info for a session (requires slug)
  app.get("/api/gist-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);
    const gist = await loadSavedGistInfo(targetDir);
    if (!gist) return c.json({ gist: null });
    return c.json({ gist });
  });

  // Publish to Gist (requires slug)
  app.post("/api/publish/gist", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSessionFromDisk(baseDir, result.slug);
      const overlaysData = await loadOverlays(baseDir, result.slug);
      const targetSession = sessionWithEffectiveContent(rawSession, overlaysData);

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

  // Export HTML (requires slug)
  app.post("/api/export/html", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSessionFromDisk(baseDir, result.slug);
      const overlaysData = await loadOverlays(baseDir, result.slug);
      const targetSession = sessionWithEffectiveContent(rawSession, overlaysData);

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
    const targetDir = join(baseDir, result.slug);
    try {
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
    const targetDir = join(baseDir, result.slug);

    try {
      const rawSession = await loadSessionFromDisk(baseDir, result.slug);
      const overlaysData = await loadOverlays(baseDir, result.slug);
      const targetSession = sessionWithEffectiveContent(rawSession, overlaysData);

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
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // --- Overlays (requires slug) ---
  app.get("/api/overlays", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const overlays = await loadOverlays(baseDir, result.slug);
    return c.json(overlays);
  });

  app.post("/api/overlays", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
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
      await saveOverlays(baseDir, result.slug, body);
    } catch {
      /* ignore */
    }
    return c.json({ ok: true });
  });

  // --- Overlay chaining helper ---
  // When running a new operation (translate/tone), use effective content from existing
  // overlays so operations chain correctly (e.g. soften AFTER translate works on translated text)
  function sessionWithEffectiveContent(
    session: ReplaySession,
    existing: SessionOverlays,
  ): ReplaySession {
    if (existing.overlays.length === 0) return session;
    // For each scene, find the latest overlay by updatedAt
    const latestByScene = new Map<number, { value: string; time: string }>();
    for (const o of existing.overlays) {
      const current = latestByScene.get(o.sceneIndex);
      if (!current || o.updatedAt > current.time) {
        latestByScene.set(o.sceneIndex, { value: o.modifiedValue, time: o.updatedAt });
      }
    }
    if (latestByScene.size === 0) return session;
    return {
      ...session,
      scenes: session.scenes.map((scene, i) => {
        const entry = latestByScene.get(i);
        if (!entry) return scene;
        if (scene.type === "user-prompt" || scene.type === "text-response") {
          return { ...scene, content: entry.value };
        }
        return scene;
      }),
    };
  }

  // After generation, fix originalValue to be the TRUE original from the unmodified session
  function fixOriginalValues(
    overlays: import("./types.js").SceneOverlay[],
    originalSession: ReplaySession,
  ) {
    for (const overlay of overlays) {
      const scene = originalSession.scenes[overlay.sceneIndex];
      if (scene && (scene.type === "user-prompt" || scene.type === "text-response")) {
        overlay.originalValue = scene.content;
      }
    }
  }

  // --- AI Studio: Translate (requires slug) ---
  app.post("/api/studio/translate", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);

    try {
      const body = await c.req
        .json<{ toolName?: string; targetLang?: string; sourceLang?: string }>()
        .catch(() => ({}));
      const detected = await detectFeedbackTools();
      if (detected.tools.length === 0) {
        return c.json({ error: "No AI CLI tool available (claude, agent, or opencode)" }, 400);
      }
      const toolName = typeof body.toolName === "string" ? body.toolName : undefined;
      const tool = toolName
        ? detected.tools.find((t) => t.name === toolName) || null
        : detected.defaultTool;
      if (!tool) {
        return c.json({ error: `Requested tool is not available: ${toolName}` }, 400);
      }

      const targetSession = await loadSessionFromDisk(baseDir, result.slug);
      const targetLang = typeof body.targetLang === "string" ? body.targetLang : "English";
      const sourceLang = typeof body.sourceLang === "string" ? body.sourceLang : undefined;

      // Load existing overlays BEFORE generation so we can chain operations
      const existing = await loadOverlays(baseDir, result.slug);
      // Remove translate overlays — we're replacing them. Keep others (tone etc.) for chaining.
      const nonTranslateOverlays = existing.overlays.filter((o) => o.source.type !== "translate");
      const chainBase: SessionOverlays = { version: 1, overlays: nonTranslateOverlays };
      const effectiveSession = sessionWithEffectiveContent(targetSession, chainBase);

      const translationResult = await generateTranslation(effectiveSession, tool, {
        targetLang,
        sourceLang,
      });
      if (!translationResult) {
        return c.json({ error: "Could not generate translations (invalid AI output)" }, 500);
      }
      // Restore true originalValue from the unmodified session
      fixOriginalValues(translationResult.overlays, targetSession);
      const merged: SessionOverlays = {
        version: 1,
        overlays: [...nonTranslateOverlays, ...translationResult.overlays],
      };
      await saveOverlays(baseDir, result.slug, merged);

      return c.json({
        overlays: merged,
        stats: translationResult.stats,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // --- AI Studio: Tone Adjustment (requires slug) ---
  app.post("/api/studio/tone", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);

    try {
      const body = await c.req.json<{ toolName?: string; style?: string }>().catch(() => ({}));
      const detected = await detectFeedbackTools();
      if (detected.tools.length === 0) {
        return c.json({ error: "No AI CLI tool available (claude, agent, or opencode)" }, 400);
      }
      const toolName = typeof body.toolName === "string" ? body.toolName : undefined;
      const tool = toolName
        ? detected.tools.find((t) => t.name === toolName) || null
        : detected.defaultTool;
      if (!tool) {
        return c.json({ error: `Requested tool is not available: ${toolName}` }, 400);
      }

      const targetSession = await loadSessionFromDisk(baseDir, result.slug);
      const style =
        typeof body.style === "string" &&
        ["professional", "neutral", "friendly"].includes(body.style)
          ? (body.style as "professional" | "neutral" | "friendly")
          : "professional";

      // Load existing overlays BEFORE generation so we can chain operations
      const existing = await loadOverlays(baseDir, result.slug);
      // Remove tone overlays — we're replacing them. Keep others (translate etc.) for chaining.
      const nonToneOverlays = existing.overlays.filter((o) => o.source.type !== "tone");
      const chainBase: SessionOverlays = { version: 1, overlays: nonToneOverlays };
      const effectiveSession = sessionWithEffectiveContent(targetSession, chainBase);

      const toneResult = await generateToneAdjustment(effectiveSession, tool, { style });
      if (!toneResult) {
        return c.json({ error: "Could not adjust tone (invalid AI output)" }, 500);
      }
      // Restore true originalValue from the unmodified session
      fixOriginalValues(toneResult.overlays, targetSession);
      const merged: SessionOverlays = {
        version: 1,
        overlays: [...nonToneOverlays, ...toneResult.overlays],
      };
      await saveOverlays(baseDir, result.slug, merged);

      return c.json({
        overlays: merged,
        stats: toneResult.stats,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  // Dev mode: use VIBE_API_PORT env (set by scripts/dev.mjs) or fall back to 13456
  // Production: port 0 lets the OS pick a free port (no conflicts)
  const requestedPort = opts?.externalViewerUrl ? Number(process.env.VIBE_API_PORT) || 13456 : 0;

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
      if (process.env.VIBE_REPLAY_NO_AUTO_OPEN !== "1") {
        open(browseUrl);
      }
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

export const __testables = {
  countSessionStats,
  pickSourceRecordForSession,
  selectCursorEnrichmentCandidates,
  sourceSessionKey,
};
