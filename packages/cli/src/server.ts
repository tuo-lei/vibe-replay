import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type FSWatcher, watch as fsWatch } from "node:fs";
import {
  mkdir,
  open as fsOpen,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import chalk from "chalk";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import open from "open";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText, previewPrompt } from "./clean-prompt.js";
import { computeDaysUntilCleanup, getClaudeCodeCleanupPeriod } from "./cleanup-warning.js";
import {
  detectFeedbackTools,
  generateFeedback,
  generateToneAdjustment,
  generateTranslation,
} from "./feedback.js";
import { generateGitHubGif } from "./formatters/gif.js";
import { generateGitHubMarkdown, generateGitHubSvg } from "./formatters/github.js";
import { generateOutput, injectDataScript, loadViewerHtml } from "./generator.js";
import { mergeInsights, readInsightsStore, writeInsightsStore } from "./insights.js";
import { loadOverlays, sessionWithEffectiveContent } from "./overlays.js";
import { parseClaudeCodeLines } from "./providers/claude-code/parser.js";
import { parseCodexLines } from "./providers/codex/parser.js";
import { resolveCursorLiveWatchPaths } from "./providers/cursor/sqlite-reader.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import {
  getApiUrl,
  getSessionCookieName,
  loadAllAuthTokens,
  loadAnyAuthToken,
  loadAuthToken,
  loadSavedCloudInfo,
  publishCloudWithOverlays,
  removeAuthToken,
  saveAuthToken,
} from "./publishers/cloud.js";
import {
  checkPublishStatus,
  loadSavedGistInfo,
  publishGist,
  type SavedGistInfo,
} from "./publishers/gist.js";
import { scanForSecrets } from "./scan.js";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  type BackgroundScanState,
  type ProjectInsights,
  readProjectMemory,
  runBackgroundScan,
  type ScanInput,
  type SessionScanResult,
  type UserInsights,
} from "./scanner.js";
import { transformToReplay } from "./transform.js";
import type {
  Annotation,
  ParsedTurn,
  ReplaySession,
  SessionInfo,
  SessionOverlays,
} from "./types.js";
import { localDayKey, normalizeTitle } from "./utils.js";
import { CLI_VERSION } from "./version.js";

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

function normalizeProjectPath(project: string): string {
  const home = homedir();
  return project.startsWith(home) ? `~${project.slice(home.length)}` : project;
}

// Keep cloud sync requests comfortably below the current D1 bind / batch ceiling.
const MAX_INSIGHTS_SYNC_DAYS_PER_REQUEST = 90;

function chunkItems<T>(items: T[], maxItems: number): T[][] {
  if (maxItems <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxItems) {
    chunks.push(items.slice(i, i + maxItems));
  }
  return chunks;
}

function buildInsightsSyncBatches<T extends { date: string }>(
  days: T[],
  existingDates: Iterable<string>,
  today: string,
  maxDaysPerBatch = MAX_INSIGHTS_SYNC_DAYS_PER_REQUEST,
): T[][] {
  const existing = new Set(existingDates);
  const pending = days.filter((day) => !existing.has(day.date) || day.date === today);
  return chunkItems(pending, maxDaysPerBatch);
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

/** Scan replay.json files from a single directory */
async function scanSessionsFromDir(baseDir: string): Promise<ReplaySummary[]> {
  const results: ReplaySummary[] = [];
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

      const cloudInfo = await loadSavedCloudInfo(join(baseDir, entry));

      const userPrompts = (session.scenes || [])
        .filter((sc) => sc.type === "user-prompt")
        .map((sc) => previewPrompt(sc.content))
        .filter((m) => m.length >= 10);
      const firstMessage = userPrompts[0] || undefined;
      const messages = userPrompts.length > 0 ? userPrompts.slice(0, 2) : undefined;

      const generatorVersion = session.meta.generator?.version;
      const replayOutdated = generatorVersion ? generatorVersion !== CLI_VERSION : false;

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
        replaySize: Buffer.byteLength(raw, "utf-8"),
        generatorVersion,
        replayOutdated,
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
        cloud: cloudInfo
          ? {
              id: cloudInfo.id,
              url: cloudInfo.url,
              expiresAt: cloudInfo.expiresAt,
              updatedAt: cloudInfo.updatedAt,
            }
          : undefined,
      });
    } catch {}
  }

  return results;
}

/** Scan replay.json from primary dir (~/.vibe-replay/) + optional CWD fallback (./vibe-replay/) */
async function scanSessions(baseDir: string): Promise<ReplaySummary[]> {
  const dirs = [baseDir];
  // Also scan ./vibe-replay/ in CWD for backwards compatibility
  const cwdLocal = resolve("./vibe-replay");
  if (cwdLocal !== baseDir) {
    dirs.push(cwdLocal);
  }

  const allResults: ReplaySummary[] = [];
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
  hasSdk?: boolean;
  isStarred?: boolean;
  spaceId?: string;
  spaceIdSetBy?: string;
  pluginsEnabled?: boolean;
  skillsEnabled?: boolean;
  fsDetectedFiles?: string[];
  timestamp: string;
  [key: string]: unknown;
}

/** Summary of a generated replay, returned by scanSessionsFromDir / scanSessions */
interface ReplaySummary {
  slug: string;
  baseDir: string;
  sessionId: string;
  title?: string;
  provider: string;
  model?: string;
  project: string;
  startTime: string;
  endTime?: string;
  stats: ReplaySession["meta"]["stats"];
  replaySize: number;
  generatorVersion?: string;
  replayOutdated: boolean;
  hasAnnotations: boolean;
  annotationCount: number;
  firstMessage?: string;
  messages?: string[];
  gist?: {
    gistId?: string;
    viewerUrl?: string;
    updatedAt?: string;
    outdated: boolean;
  };
  cloud?: {
    id: string;
    url: string;
    expiresAt?: string;
    updatedAt?: string;
  };
}

/** SourceSummaryRecord enriched with replay info for the sources cache */
interface CachedSourceRecord extends SourceSummaryRecord {
  existingReplay?: string | null;
  replay?: Omit<ReplaySummary, "baseDir" | "generatorVersion" | "replayOutdated">;
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

interface PersistedInsightsCache {
  userInsights: UserInsights | null;
  projectInsights: Array<[string, ProjectInsights]>;
  computedAt: string | null;
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
        (s.promptCount == null ||
          s.toolCallCount == null ||
          typeof s.title !== "string" ||
          !s.title.trim() ||
          typeof s.model !== "string" ||
          !s.model ||
          looksLikeCursorDisplayNoise(s.title) ||
          looksLikeCursorDisplayNoise(s.firstPrompt)) &&
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
        (block) => block.type === "_user_images" && block.images.length > 0,
      );
      if (hasText || hasImages) promptCount++;
    }
    for (const block of turn.blocks) {
      if (block.type === "tool_use") toolCallCount++;
    }
  }
  return { promptCount, toolCallCount };
}

function extractPromptPreviewsFromTurns(turns: ParsedTurn[], limit = 3): string[] {
  const prompts: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" || turn.subtype === "compaction-summary") continue;
    const text = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const cleaned = previewPrompt(text);
    if (cleaned.length < 8 || prompts.includes(cleaned)) continue;
    prompts.push(cleaned);
    if (prompts.length >= limit) break;
  }
  return prompts;
}

function looksLikeCursorDisplayNoise(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return !cleanPromptText(value);
}

/** Build dual lookup maps for replays — match by slug or sessionId */
function buildReplayMaps(replays: ReplaySummary[]): {
  bySlug: Map<string, ReplaySummary>;
  bySessionId: Map<string, ReplaySummary>;
} {
  const bySlug = new Map<string, ReplaySummary>();
  const bySessionId = new Map<string, ReplaySummary>();
  for (const r of replays) {
    bySlug.set(r.slug, r);
    if (r.sessionId) bySessionId.set(r.sessionId, r);
  }
  return { bySlug, bySessionId };
}

async function buildSourcesResult(
  merged: SessionInfo[],
  baseDir: string,
  home: string,
  previousSources: SourceSummaryRecord[] = [],
  cleanupPeriodDays = 0,
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
  // Match by both slug and sessionId — replay directory name may differ from source slug
  // (e.g. source slug "mighty-questing-waffle" vs replay dir "045ef7d9" from sessionId)
  const existingReplays = await scanSessions(baseDir);
  const { bySlug: replayBySlug, bySessionId: replayBySessionId } = buildReplayMaps(existingReplays);

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
    const replay = replayBySlug.get(s.slug) || replayBySessionId.get(s.sessionId);
    const promptCount = s.promptCount ?? previous?.promptCount;
    const toolCallCount = s.toolCallCount ?? previous?.toolCallCount;
    return {
      provider: s.provider,
      sessionId: s.sessionId,
      slug: s.slug,
      title: normalizeTitle(cleanPromptText(typeof s.title === "string" ? s.title : "")),
      project: s.project,
      timestamp: s.timestamp,
      fileSize: s.fileSize,
      lineCount: s.lineCount,
      promptCount,
      toolCallCount,
      firstPrompt: previewPrompt(s.firstPrompt),
      prompts: s.prompts?.map((p) => previewPrompt(p)),
      filePaths: s.filePaths,
      toolPaths: s.toolPaths,
      hasSqlite: s.hasSqlite,
      hasSdk: s.hasSdk,
      gitBranch: s.gitBranch,
      model: s.model,
      durationMsEst: s.durationMsEst,
      editCountEst: s.editCountEst,
      hasPR: s.hasPR,
      isStarred: s.isStarred,
      spaceId: s.spaceId,
      spaceIdSetBy: s.spaceIdSetBy,
      pluginsEnabled: s.pluginsEnabled,
      skillsEnabled: s.skillsEnabled,
      fsDetectedFiles: s.fsDetectedFiles,
      expiresInDays:
        s.provider === "claude-code" && cleanupPeriodDays > 0
          ? computeDaysUntilCleanup(s.timestamp, cleanupPeriodDays)
          : undefined,
      existingReplay: replay ? (replay.slug as string) : null,
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
            replaySize: replay.replaySize,
            gist: replay.gist,
            cloud: replay.cloud,
          }
        : undefined,
    };
  });
}

/**
 * Live-session state derived from Claude Code's per-process metadata file
 * (`~/.claude/sessions/<pid>.json`).
 *
 * - `busy`    — Claude is actively processing (streaming a response, running a
 *               tool, etc.). The metadata file's `status` field is "busy" and
 *               its PID is alive.
 * - `idle`    — Claude is alive but waiting on the user (prompt input is
 *               focused, no in-flight request). `status` is anything other
 *               than "busy" and PID is alive.
 * - `stopped` — No metadata file matches `sessionId`, the file lacks a
 *               `status` field (Claude exited cleanly), or the PID is dead.
 *               Cursor / Codex / Cowork sessions also fall through to this
 *               since they don't write the Claude metadata file — for those
 *               providers `state` is reported as `unknown` instead so the
 *               viewer doesn't claim "Session ended" when we genuinely
 *               can't tell.
 */
type LiveSessionState = "busy" | "idle" | "stopped" | "unknown";

/**
 * Walk `~/.claude/sessions/*.json` looking for an alive process whose
 * sessionId matches. After a `/resume` (or any abnormal exit), the dir
 * can hold multiple files for the same logical session — the dead
 * pre-resume one and the live post-resume one — and `readdir` order is
 * not guaranteed. We must inspect every match and only conclude
 * "stopped" once all of them are dead/missing-status.
 *
 * Known limitation: PID recycling. If a Claude process exits without
 * cleaning up its metadata file and a new process happens to claim the
 * same PID, this function will report busy/idle for one tick. The 2s
 * poller corrects on the next iteration once the recycled process
 * touches the state file (or doesn't, surfacing "stopped"). Probability
 * is low and the false reading self-heals.
 */
async function readClaudeSessionState(sessionId: string): Promise<LiveSessionState> {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return "stopped";
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let data: { sessionId?: string; pid?: number; status?: string };
    try {
      const content = await readFile(join(sessionsDir, file), "utf-8");
      data = JSON.parse(content);
    } catch {
      continue;
    }
    if (data.sessionId !== sessionId) continue;
    // Partial / racing-write file (pid not flushed yet, status absent on
    // first init) — keep iterating; another file may carry the live state.
    if (typeof data.pid !== "number" || !data.status) continue;

    // Liveness probe via signal 0. Two errors to disambiguate:
    //   ESRCH — process truly gone → keep looking, prefer a live match
    //           if any other file matches; only "stopped" if none do.
    //   EPERM — process exists but we can't signal it (different uid,
    //           e.g. Claude was started under sudo). Treat as alive.
    let alive = false;
    try {
      process.kill(data.pid, 0);
      alive = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") alive = true;
    }
    if (alive) return data.status === "busy" ? "busy" : "idle";
    // Dead PID — don't return yet; another file may be the live one.
  }
  return "stopped";
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
    openLive?: { provider: string; sessionId: string };
    externalViewerUrl?: string;
  },
): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const isDevMode = !!opts?.externalViewerUrl;
  // In dev mode, Vite serves the viewer with HMR — no need to load/cache viewer HTML
  const viewerHtml = isDevMode ? "" : await loadViewerHtml();
  // Read once at startup — changes to ~/.claude/settings.json require server restart
  const cleanupPeriodDays = await getClaudeCodeCleanupPeriod();
  const cacheKeySuffix = createHash("sha1").update(baseDir).digest("hex").slice(0, 12);
  // Bumped v2 → v3 after fixing the Cowork sessionId derivation: earlier v2
  // caches stored cliSessionId (inner-subprocess UUID) as the Cowork session's
  // identity, which never matches what the parser reads from audit.jsonl and
  // permanently broke replay-to-source linking. Bumping discards those caches.
  // v3 → v4: added `hasSdk` flag for Cursor SDK-backed sessions; old caches
  // omit the field so the dashboard can't render the SDK badge until refreshed.
  const sourcesCacheKey = `dashboard-sources-v4-${cacheKeySuffix}`;
  const replaysCacheKey = `dashboard-replays-v1-${cacheKeySuffix}`;
  const scanResultsCacheKey = `dashboard-scan-results-v1-${cacheKeySuffix}`;
  const insightsCacheKey = `dashboard-insights-v1-${cacheKeySuffix}`;
  const refreshReplaysCache = async (): Promise<any[] | null> => {
    try {
      const sessions = await scanSessions(baseDir);
      await writeFileCache(replaysCacheKey, sessions);
      return sessions;
    } catch {
      // Best-effort cache refresh for dashboard listing.
      // Return null (not []) so callers can distinguish "scan failed" from "no replays".
      return null;
    }
  };

  /** After replays change, sync the sources cache so existingReplay / replay stay consistent */
  const syncSourcesCacheWithReplays = async (replays: ReplaySummary[]): Promise<void> => {
    try {
      const cached = await readFileCache<CachedSourceRecord[]>(sourcesCacheKey);
      if (!cached?.data?.length) return;

      const { bySlug, bySessionId } = buildReplayMaps(replays);

      let changed = false;
      const updated = cached.data.map((s) => {
        const replay =
          bySlug.get(s.slug) || (s.sessionId ? bySessionId.get(s.sessionId) : undefined);
        const hadReplay = !!s.existingReplay;
        const hasReplay = !!replay;
        if (
          hadReplay !== hasReplay ||
          (hasReplay && (replay.slug !== s.existingReplay || replay.title !== s.replay?.title))
        ) {
          changed = true;
        }
        return {
          ...s,
          existingReplay: replay ? replay.slug : null,
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
                replaySize: replay.replaySize,
                gist: replay.gist,
                cloud: replay.cloud,
              }
            : undefined,
        };
      });

      if (changed) {
        await writeFileCache(sourcesCacheKey, updated);
      }
    } catch {
      // Best-effort — never break core flows
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
          const promptPreviews = extractPromptPreviewsFromTurns(parsed.turns);
          const enrichedTitle =
            normalizeTitle(cleanPromptText(parsed.title || "")) ||
            normalizeTitle(promptPreviews[0] || "");
          const enrichedFirstPrompt =
            promptPreviews[0] ||
            previewPrompt(parsed.title || "") ||
            previewPrompt(session.firstPrompt);
          const target = pickSourceRecordForSession(session, bySessionId, byKey);
          if (target) {
            let targetChanged = false;
            if (target.promptCount !== counts.promptCount) {
              target.promptCount = counts.promptCount;
              targetChanged = true;
            }
            if (target.toolCallCount !== counts.toolCallCount) {
              target.toolCallCount = counts.toolCallCount;
              targetChanged = true;
            }
            if (typeof enrichedTitle === "string" && target.title !== enrichedTitle) {
              target.title = enrichedTitle;
              targetChanged = true;
            }
            if (enrichedFirstPrompt && target.firstPrompt !== enrichedFirstPrompt) {
              target.firstPrompt = enrichedFirstPrompt;
              targetChanged = true;
            }
            const nextPrompts = promptPreviews.length > 0 ? promptPreviews : undefined;
            if (JSON.stringify(target.prompts) !== JSON.stringify(nextPrompts)) {
              target.prompts = nextPrompts;
              targetChanged = true;
            }
            if (parsed.model && target.model !== parsed.model) {
              target.model = parsed.model;
              targetChanged = true;
            }
            if (parsed.gitBranch && target.gitBranch !== parsed.gitBranch) {
              target.gitBranch = parsed.gitBranch;
              targetChanged = true;
            }
            if (targetChanged) {
              changed = true;
              sourcesEnrichmentStatus = {
                ...sourcesEnrichmentStatus,
                updated: sourcesEnrichmentStatus.updated + 1,
              };
            }
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

  const persistedScanResults = await readFileCache<SessionScanResult[]>(scanResultsCacheKey);
  const persistedInsights = await readFileCache<PersistedInsightsCache>(insightsCacheKey);

  // ─── Background session scanner state ─────────────────────────────
  let scanState: BackgroundScanState = {
    running: false,
    scanned: persistedScanResults?.data.length || 0,
    total: persistedScanResults?.data.length || 0,
    results: persistedScanResults?.data || [],
    finishedAt: persistedScanResults?.updatedAt,
  };

  // Pre-computed insights cache — populated after each scan completes.
  // Kept across scans (stale-while-refresh): new scan overwrites, never clears.
  let insightsCache: {
    userInsights: UserInsights | null;
    projectInsights: Map<string, ProjectInsights>;
    computedAt: string | null;
  } = persistedInsights?.data
    ? {
        userInsights: persistedInsights.data.userInsights,
        projectInsights: new Map(persistedInsights.data.projectInsights),
        computedAt: persistedInsights.data.computedAt,
      }
    : {
        userInsights: null,
        projectInsights: new Map(),
        computedAt: null,
      };

  /** Persist scan results into the durable local insights store. */
  const persistInsightsFromScan = async (results: SessionScanResult[]): Promise<void> => {
    const store = await readInsightsStore();
    const updated = mergeInsights(store, results);
    await writeInsightsStore(updated);
  };

  /** Track last auto-sync date to avoid syncing more than once per day. */
  let lastAutoSyncDate: string | null = null;

  /** Simple mutex to prevent concurrent sync operations on the insights store. */
  let syncLock: Promise<unknown> = Promise.resolve();

  /**
   * Aggregate local insights by (date, machineId) and push to cloud.
   * Each day becomes one row in cloud — Prometheus-style time series.
   */
  const syncInsightsToCloud = async (): Promise<{
    synced: number;
    total: number;
    error?: string;
  }> => {
    const { aggregateDailyInsights } = await import("./insights.js");
    const {
      loadAuthToken: loadAuth,
      getApiUrl: getUrl,
      getSessionCookieName: getCookie,
    } = await import("./publishers/cloud.js");

    const auth = await loadAuth();
    if (!auth) return { synced: 0, total: 0, error: "Not logged in" };

    const store = await readInsightsStore();
    const daily = aggregateDailyInsights(store);
    if (daily.days.length === 0) return { synced: 0, total: 0 };

    const apiUrl = getUrl();
    const cookieName = getCookie(apiUrl);
    const headers = { "Content-Type": "application/json", Cookie: `${cookieName}=${auth.token}` };
    const today = localDayKey(new Date())!;
    let existingDates = new Set<string>();

    // Delta sync: fetch dates already on cloud, skip them
    try {
      const datesResp = await fetch(
        `${apiUrl}/api/insights/dates?machineId=${encodeURIComponent(daily.machineId)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (datesResp.ok) {
        const { dates } = (await datesResp.json()) as { dates: string[] };
        existingDates = new Set(dates);
      }
    } catch {
      // Failed to fetch dates — fall back to full sync (cloud will upsert)
    }

    const batches = buildInsightsSyncBatches(daily.days, existingDates, today);
    const totalDays = batches.reduce((sum, batch) => sum + batch.length, 0);
    if (totalDays === 0) return { synced: 0, total: 0 };

    let synced = 0;
    for (const batch of batches) {
      let resp: Response;
      try {
        resp = await fetch(`${apiUrl}/api/insights/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...daily, days: batch }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        return {
          synced,
          total: totalDays,
          error: e instanceof Error ? e.message : "Network error",
        };
      }

      if (resp.status === 401) {
        await clearLocalAuthSession();
        return { synced, total: totalDays, error: "Session expired" };
      }
      if (!resp.ok) {
        const err = await resp.text().catch(() => `HTTP ${resp.status}`);
        return { synced, total: totalDays, error: err };
      }

      let result: { synced: number };
      try {
        result = await resp.json();
      } catch {
        return { synced, total: totalDays, error: "Invalid response" };
      }

      synced += result.synced;
    }

    return { synced, total: totalDays };
  };

  /**
   * Auto-sync insights to cloud if user is logged in.
   * Runs at most once per calendar day to avoid excessive writes.
   */
  const autoSyncInsights = (): Promise<void> => {
    const today = localDayKey(new Date())!;
    if (lastAutoSyncDate === today) return Promise.resolve();
    // Serialize through syncLock to prevent concurrent read-modify-write on the store
    const job = syncLock.then(async () => {
      if (lastAutoSyncDate === today) return; // Re-check after acquiring lock
      const result = await syncInsightsToCloud();
      if (!result.error) lastAutoSyncDate = today;
    });
    syncLock = job.catch(() => {});
    return job;
  };

  /** Pre-compute all insights from scan results and store in cache. */
  const precomputeInsightsCache = async (results: SessionScanResult[]): Promise<void> => {
    // User-level insights
    const user = aggregateUserInsights(results);

    // Project-level insights for each unique project
    const projects = new Map<string, ProjectInsights>();
    const uniqueProjects = new Set(results.map((r) => r.project));
    for (const project of uniqueProjects) {
      const memory = await readProjectMemory(project);
      const pi = aggregateProjectInsights(project, results, memory || undefined);
      projects.set(project, pi);
    }

    // Enrich topProjects with memoryFileCount
    for (const tp of user.topProjects) {
      const pi = projects.get(tp.project);
      if (pi?.memory) {
        tp.memoryFileCount = pi.memory.memoryFiles.length;
      }
    }

    insightsCache = {
      userInsights: user,
      projectInsights: projects,
      computedAt: new Date().toISOString(),
    };
    await writeFileCache<PersistedInsightsCache>(insightsCacheKey, {
      userInsights: insightsCache.userInsights,
      projectInsights: [...insightsCache.projectInsights.entries()],
      computedAt: insightsCache.computedAt,
    });
  };

  /**
   * Start background session scanning. Discovers all sessions, then scans
   * each one (newest first) to extract metadata for insights. Uses cache
   * so unchanged sessions are skipped.
   */
  const startBackgroundScan = (): void => {
    if (scanState.running) return;
    const previousResults = scanState.results;
    const previousFinishedAt = scanState.finishedAt;
    scanState = {
      running: true,
      scanned: 0,
      total: 0,
      results: previousResults,
      phase: "discovering",
      startedAt: new Date().toISOString(),
      finishedAt: previousFinishedAt,
    };

    void (async () => {
      try {
        // Discover all sessions
        const providers = getAllProviders();
        const allSessions: SessionInfo[] = [];
        for (const provider of providers) {
          const sessions = await provider.discover();
          allSessions.push(...sessions);
        }
        const merged = mergeSameSessions(allSessions);

        // Normalize project paths
        const home = homedir();
        for (const s of merged) {
          if (s.project.startsWith(home)) {
            s.project = `~${s.project.slice(home.length)}`;
          }
        }

        // Build scan inputs (newest first — already sorted by discovery)
        const scanInputs: ScanInput[] = merged.map((s) => ({
          sessionId: s.sessionId,
          provider: s.provider,
          project: s.project,
          slug: s.slug,
          filePaths: s.filePaths,
          toolPaths: s.toolPaths,
          sourceFilePath: s.filePath,
          sourceFileSize: s.fileSize,
          sourceLineCount: s.lineCount,
          workspacePath: s.workspacePath,
          hasSqlite: s.hasSqlite,
          deferRichCursorParse: s.provider === "cursor" && !!s.hasSqlite,
          timestamp: s.timestamp,
          title: s.title,
          firstPrompt: s.firstPrompt,
        }));

        scanState.total = scanInputs.length;

        const results = await runBackgroundScan(scanInputs, (progress) => {
          scanState = {
            ...scanState,
            phase: "scanning",
            scanned: progress.scanned,
            total: progress.total,
            currentSession: progress.currentSession,
          };
        });

        scanState = {
          running: false,
          scanned: results.length,
          total: scanInputs.length,
          results,
          currentSession: undefined,
          phase: undefined,
          startedAt: scanState.startedAt,
          finishedAt: new Date().toISOString(),
        };

        await writeFileCache(scanResultsCacheKey, results);

        // Persist insights to durable local store (survives source file deletion)
        persistInsightsFromScan(results)
          .then(() => autoSyncInsights()) // Auto-sync to cloud if logged in
          .catch(() => {});

        // Pre-compute insights cache in background (non-blocking)
        precomputeInsightsCache(results).catch(() => {});
      } catch {
        scanState = {
          ...scanState,
          running: false,
          currentSession: undefined,
          phase: undefined,
          finishedAt: new Date().toISOString(),
        };
      }
    })();
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
    // Reuse injectDataScript so we get the same `lastIndexOf("</head>")` handling
    // (minified JS in the viewer bundle may contain the literal string `</head>`)
    // plus a clear error if the build is corrupted, instead of silently producing
    // broken HTML.
    const html = injectDataScript(viewerHtml, flag);
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

  // --- Live: stream a session as it's being written to disk ---
  // For append-only JSONL providers we tail each shard at the byte level — fs.read() at
  // the cached offset, accumulate complete lines, hold an incomplete trailing
  // fragment until the next newline arrives. Other providers fall back to
  // full provider.parse() on every change (their formats aren't pure JSONL).
  // The transformed ReplaySession is pushed as a full snapshot over SSE; the
  // viewer hot-swaps and auto-follows the tail when the user is there.
  app.get("/api/live", (c) => {
    const providerName = c.req.query("provider") || "";
    const sessionId = c.req.query("sessionId") || "";

    return streamSSE(c, async (stream) => {
      const sendError = async (message: string) => {
        await stream.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      };

      if (!providerName || !sessionId) {
        await sendError("provider and sessionId query parameters are required");
        return;
      }

      const provider = getProvider(providerName);
      if (!provider) {
        await sendError(`Unknown provider: ${providerName}`);
        return;
      }

      // Resolve sessionId → SessionInfo. Discovery is expensive (full
      // ~/.claude/projects walk for Claude), so we only run it on the
      // initial connect and on a 15s cadence inside buildAndSend — that's
      // the safety net that picks up `/resume` shards mid-stream.
      //
      // `mergeSameSessions` keeps the latest shard's sessionId on the merged
      // record, so we look the user-supplied sessionId up against the
      // unmerged list first (any shard matches), then return the merged
      // record for that shard's project+slug — the viewer can pass whichever
      // sessionId it happens to know about and still get the full history.
      const resolveSessionInfo = async () => {
        const all = await provider.discover();
        const seed = all.find((s) => s.sessionId === sessionId);
        if (!seed) return undefined;
        const merged = mergeSameSessions(all);
        return merged.find((s) => s.project === seed.project && s.slug === seed.slug);
      };

      let sessionInfo = await resolveSessionInfo();
      if (!sessionInfo) {
        await sendError(`Session not found: ${sessionId}`);
        return;
      }

      const home = homedir();
      const projectFor = (info: SessionInfo): string =>
        info.project.startsWith(home) ? `~${info.project.slice(home.length)}` : info.project;

      const watchers: FSWatcher[] = [];
      const watchedPaths = new Set<string>();
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let aborted = false;
      let inFlight = false;
      let dirty = false;
      let lastSignature: string | null = null;
      // Live session state (busy / idle / stopped / unknown) — populated
      // from `~/.claude/sessions/<pid>.json` for Claude. Other providers
      // don't write that file, so they get "unknown" and the viewer keeps
      // the existing always-live UI rather than misreporting "stopped".
      const isClaudeProvider = providerName === "claude-code";
      const isCursorProvider = providerName === "cursor";
      const isCodexProvider = providerName === "codex";
      const isJsonlLiveProvider = isClaudeProvider || isCodexProvider;
      let lastLiveState: LiveSessionState = isClaudeProvider ? "busy" : "unknown";
      let cursorDbWatchAttached = false;
      const cursorDbWatchedSessionIds = new Set<string>();
      const cursorDbWatchAttemptedAt = new Map<string, number>();
      const CURSOR_DB_WATCH_RETRY_MS = 15_000;

      const ensureWatchersFor = (paths: Iterable<string>): void => {
        for (const fp of paths) {
          if (aborted || watchedPaths.has(fp)) continue;
          try {
            const w = fsWatch(fp, { persistent: false }, () => scheduleRebuild());
            w.on("error", () => {});
            watchers.push(w);
            watchedPaths.add(fp);
          } catch {
            // best-effort — if a path can't be watched, the others may still work
          }
        }
      };

      const ensureCursorDbWatchersFor = async (info: SessionInfo): Promise<void> => {
        if (!isCursorProvider || !info.hasSqlite || cursorDbWatchedSessionIds.has(info.sessionId)) {
          return;
        }
        const now = Date.now();
        const lastAttempt = cursorDbWatchAttemptedAt.get(info.sessionId) || 0;
        if (now - lastAttempt < CURSOR_DB_WATCH_RETRY_MS) return;
        cursorDbWatchAttemptedAt.set(info.sessionId, now);

        try {
          const paths = await resolveCursorLiveWatchPaths(info.sessionId);
          const before = watchedPaths.size;
          ensureWatchersFor(paths);
          const attached = watchedPaths.size > before || paths.some((p) => watchedPaths.has(p));
          if (attached) {
            cursorDbWatchAttached = true;
            cursorDbWatchedSessionIds.add(info.sessionId);
          }
        } catch {
          // Best-effort. If DB/WAL watchers cannot be resolved, the polling
          // fallback below keeps SQLite-backed Cursor live sessions updating.
        }
      };

      // Re-resolving (full provider.discover()) is expensive — for Claude it
      // walks the whole ~/.claude/projects tree and takes seconds. We only do
      // it on a slow periodic cadence (and lazily, the next time we need to
      // build) so that fast-path rebuilds — driven by fs.watch events on the
      // already-known JSONL — pay only parse + transform cost.
      const RESOLVE_REFRESH_INTERVAL_MS = 15_000;
      let lastResolvedAt = Date.now();

      // Per-file JSONL tail cache. Tracks the last byte offset we read for
      // each path plus an unterminated trailing fragment (a JSONL append may
      // flush mid-line). Each fs.watch tick reads only the new bytes via
      // pread() instead of re-reading the whole file — a multi-thousand-line
      // session goes from O(file_size) per tick to O(new_bytes).
      //
      // `partial` is a Buffer (not a string) on purpose: a write may flush
      // mid-multi-byte-character (UTF-8 user prompts contain Chinese / emoji
      // routinely), and Buffer.toString("utf8") on a half-character silently
      // emits U+FFFD and discards the broken bytes. Holding raw bytes lets
      // us defer decoding until a `\n` arrives, by which point the next
      // read has supplied the rest of the multi-byte sequence.
      const NEWLINE = 0x0a;
      type TailCache = { offset: number; partial: Buffer; lines: string[] };
      const jsonlTail = new Map<string, TailCache>();

      const splitDecodedLines = (combined: Buffer): { lines: string[]; partial: Buffer } => {
        const lastNl = combined.lastIndexOf(NEWLINE);
        if (lastNl < 0) return { lines: [], partial: combined };
        const decoded = combined.subarray(0, lastNl).toString("utf8");
        const lines = decoded.split("\n").filter((l) => l.length > 0);
        return { lines, partial: combined.subarray(lastNl + 1) };
      };

      const tailReadJsonl = async (filePath: string): Promise<string[]> => {
        const cached = jsonlTail.get(filePath);
        let size: number;
        try {
          size = (await stat(filePath)).size;
        } catch {
          // File disappeared — drop cache so a fresh read sets up clean state.
          jsonlTail.delete(filePath);
          return cached?.lines ?? [];
        }

        // First read or file shrank (truncate / rotate) — read whole file.
        // Invariants: `offset` = absolute byte position to read NEXT (= end of
        // last read). `partial` = bytes after the last newline (may be a
        // half-written line, possibly mid-UTF8). Next call reads `[offset,
        // size)`, prepends `partial`, and re-splits at the last newline.
        //
        // offset comes from `content.length`, not the earlier stat `size`:
        // the file may grow between stat() and readFile() if Claude is
        // writing concurrently, and stamping `size` here would let the next
        // tick re-read bytes in [size, content.length) and emit them twice.
        if (!cached || size < cached.offset) {
          const content = await readFile(filePath);
          const { lines, partial } = splitDecodedLines(content);
          jsonlTail.set(filePath, { offset: content.length, partial, lines });
          return lines;
        }

        if (size === cached.offset) {
          return cached.lines;
        }

        // Read just the new tail. Use a file handle + read() at offset so we
        // don't slurp the whole file for a tiny append.
        const len = size - cached.offset;
        const fh = await fsOpen(filePath, "r");
        try {
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, cached.offset);
          const combined = cached.partial.length === 0 ? buf : Buffer.concat([cached.partial, buf]);
          const { lines, partial } = splitDecodedLines(combined);
          for (const line of lines) cached.lines.push(line);
          cached.partial = partial;
          cached.offset = size;
        } finally {
          await fh.close();
        }
        return cached.lines;
      };

      const buildAndSend = async () => {
        if (aborted) return;
        if (inFlight) {
          dirty = true;
          return;
        }
        inFlight = true;
        try {
          // Refresh sessionInfo only if it's been a while since the last
          // resolve. This lets /resume mid-stream eventually pick up new
          // JSONL shards without paying a full discovery cost on every save.
          if (Date.now() - lastResolvedAt >= RESOLVE_REFRESH_INTERVAL_MS) {
            const fresh = await resolveSessionInfo();
            if (fresh) sessionInfo = fresh;
            lastResolvedAt = Date.now();
          }
          const info = sessionInfo!;
          const paths = [...info.filePaths, ...(info.toolPaths || [])];
          // Register watchers for any new paths (e.g. /resume created a new
          // JSONL between rebuilds). Without this, appends to those new files
          // would never trigger another scheduleRebuild and the stream would
          // silently go stale.
          ensureWatchersFor(paths);
          await ensureCursorDbWatchersFor(info);
          let parsed;
          if (isJsonlLiveProvider) {
            // Tail-based fast path. Concat already-cached lines from every
            // shard (filePaths is sorted chronologically by mergeSameSessions)
            // and parse them as one stream — the parser handles cross-shard
            // continuity. Subagent agents/ files are still re-read in full
            // inside the parser, but they're typically small.
            const allLines: string[] = [];
            for (const fp of paths) {
              const lines = await tailReadJsonl(fp);
              allLines.push(...lines);
            }
            parsed = isClaudeProvider
              ? await parseClaudeCodeLines(allLines, { subagentsSourcePath: paths[0] })
              : parseCodexLines(allLines, info, paths);
          } else {
            parsed = await provider.parse(paths, info);
          }
          const replay = transformToReplay(parsed, providerName, projectFor(info), {
            generator: {
              name: "vibe-replay",
              version: CLI_VERSION,
              generatedAt: new Date().toISOString(),
            },
          });
          // Dedup on the serialized scene array. Hashing only coarse counters
          // (scene count, prompt count, last timestamp) misses content-only
          // mutations — e.g. Claude tool_result lines populate `_result` on an
          // existing tool_use scene without changing scene count or the latest
          // turn timestamp, so the user would never see tool output appear.
          // Stringify excludes meta.generator.generatedAt (which would
          // otherwise force every fs.watch tick to emit a redundant payload),
          // and is fast enough at typical session sizes (~500 scenes,
          // ~tens of KB).
          // Refresh live state before emit so the payload's `state` matches
          // the latest session metadata. This is the only state read tied to
          // file changes — the standalone 2s poller below catches busy↔idle
          // and idle→stopped transitions that don't touch the JSONL.
          // Codex has no sidecar state file, so it intentionally remains
          // "unknown" and keeps the viewer's always-live UI.
          if (isClaudeProvider) {
            lastLiveState = await readClaudeSessionState(sessionId);
          }
          const signature = JSON.stringify(replay.scenes);
          if (signature !== lastSignature) {
            lastSignature = signature;
            await stream.writeSSE({
              data: JSON.stringify({
                type: "session",
                session: replay,
                state: lastLiveState,
              }),
            });
          }
        } catch (err) {
          if (!aborted) {
            await stream
              .writeSSE({
                data: JSON.stringify({ type: "error", message: getErrorMessage(err) }),
              })
              .catch(() => {});
          }
        } finally {
          inFlight = false;
          if (dirty && !aborted) {
            dirty = false;
            // Drain the dirty flag: a rebuild was queued while we were
            // in-flight. Use a 0ms timer so the abort handler (and any other
            // awaiters) gets a chance to run before the next build starts.
            scheduleRebuild(0);
          }
        }
      };

      // 100ms debounce — claude-devtools uses the same value. Long enough to
      // coalesce a burst of fs.watch events from a single JSONL flush, short
      // enough that a streamed assistant response feels live.
      const scheduleRebuild = (delay = 100) => {
        if (aborted) return;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void buildAndSend();
        }, delay);
      };

      // Initial payload — establishes the baseline session before any deltas.
      // ensureWatchersFor() inside buildAndSend() also registers fs.watch for
      // every reported file path on this first call.
      await buildAndSend();

      // Polling fallback for sources we still cannot directly fs.watch.
      //
      // Cursor SQLite/global-state sessions now try to watch store.db/state.vscdb
      // plus their WAL files, which gives near-immediate rebuild triggers when
      // Cursor flushes DB updates. Keep a slower watchdog even after DB/WAL
      // watchers attach: SQLite can rotate WAL/SHM files and macOS file events
      // can miss in-place WAL writes, so this prevents a permanently stale stream
      // without making polling the primary update path.
      const POLL_INTERVAL_MS = 3_000;
      const CURSOR_SQLITE_WATCHDOG_MS = 10_000;
      const pollIntervalMs =
        watchedPaths.size === 0 || (!!sessionInfo?.hasSqlite && !cursorDbWatchAttached)
          ? POLL_INTERVAL_MS
          : isCursorProvider && !!sessionInfo?.hasSqlite
            ? CURSOR_SQLITE_WATCHDOG_MS
            : null;
      const pollInterval = pollIntervalMs
        ? setInterval(() => {
            if (aborted) return;
            scheduleRebuild(0);
          }, pollIntervalMs)
        : null;

      // SSE keepalive — proxies (and some browsers) drop idle connections.
      const pingInterval = setInterval(() => {
        if (aborted) return;
        stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {});
      }, 25_000);

      // Standalone state poller — Claude can transition busy↔idle (and
      // idle→stopped on exit) without touching the JSONL, so file-watch
      // alone misses those edges. We poll the metadata file at 2s; on a
      // change, push a state-only event so the viewer can swap the bottom
      // BUSY / IDLE / ENDED card without re-rendering scenes.
      const stateInterval = isClaudeProvider
        ? setInterval(async () => {
            if (aborted) return;
            try {
              const next = await readClaudeSessionState(sessionId);
              if (next === lastLiveState) return;
              lastLiveState = next;
              await stream
                .writeSSE({ data: JSON.stringify({ type: "state", state: next }) })
                .catch(() => {});
            } catch {
              // Transient state-file read failures shouldn't surface as an
              // unhandled rejection — the next tick will retry. Worst case the
              // viewer keeps showing the previous state, which is correct
              // until we observe a transition.
            }
          }, 2_000)
        : null;

      // Rediscovery heartbeat. The 15s `RESOLVE_REFRESH_INTERVAL_MS`
      // sessionInfo refresh lives INSIDE buildAndSend(), so it only runs
      // when something else has already woken us up. Without an
      // independent tick: a Claude session that does `/resume` will write
      // the new turn to a *new* JSONL shard while the old shard goes
      // silent — no fs.watch event fires on the old file, polling is
      // disabled (watchedPaths is non-empty, hasSqlite is false), and
      // the live stream silently stalls until the user reconnects.
      // Fire scheduleRebuild() every 15s as the safety net; the existing
      // dedup signature absorbs the no-op when nothing changed.
      const rediscoverInterval = setInterval(() => {
        if (aborted) return;
        scheduleRebuild(0);
      }, RESOLVE_REFRESH_INTERVAL_MS);

      // Block until the client disconnects, then tear down.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          aborted = true;
          if (pendingTimer) clearTimeout(pendingTimer);
          clearInterval(pingInterval);
          if (pollInterval) clearInterval(pollInterval);
          if (stateInterval) clearInterval(stateInterval);
          clearInterval(rediscoverInterval);
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // ignore close errors during teardown
            }
          }
          resolve();
        });
      });
    });
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
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);

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
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);
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
      const result = await buildSourcesResult(
        merged,
        baseDir,
        homedir(),
        previous?.data || [],
        cleanupPeriodDays,
      );

      await writeFileCache(sourcesCacheKey, result);
      enrichCursorStatsInBackground(merged, result);
      return c.json({ sessions: result, cleanupPeriodDays });
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
        const result = await buildSourcesResult(
          merged,
          baseDir,
          homedir(),
          previous?.data || [],
          cleanupPeriodDays,
        );

        await writeFileCache(sourcesCacheKey, result);
        enrichCursorStatsInBackground(merged, result);
        await stream.writeSSE({
          data: JSON.stringify({ type: "complete", sessions: result, cleanupPeriodDays }),
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
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);

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

  // --- Regenerate all existing replays ---
  app.post("/api/regenerate-all", async (c) => {
    const replaysDir = baseDir;
    const { readdir, readFile: readF } = await import("node:fs/promises");
    const results: Array<{ slug: string; status: string; scenes?: number }> = [];

    // Discover all sessions across all providers
    const allProviders = getAllProviders();
    const allSessions: SessionInfo[] = [];
    for (const provider of allProviders) {
      try {
        const sessions = mergeSameSessions(await provider.discover());
        allSessions.push(...sessions);
      } catch {}
    }

    let entries: string[];
    try {
      entries = await readdir(replaysDir);
    } catch {
      return c.json({ error: "No replays directory" }, 404);
    }

    for (const slug of entries) {
      if (slug.startsWith(".") || slug === "cache") continue;
      try {
        const replayPath = join(replaysDir, slug, "replay.json");
        const raw = await readF(replayPath, "utf-8").catch(() => null);
        if (!raw) continue;

        const oldReplay = JSON.parse(raw);
        const sessionId = oldReplay.meta?.sessionId;
        const providerName = oldReplay.meta?.provider || "claude-code";
        if (!sessionId) {
          results.push({ slug, status: "skipped: no sessionId" });
          continue;
        }

        // Find source session by sessionId
        const sessionInfo = allSessions.find((s) => s.sessionId === sessionId);
        if (!sessionInfo || sessionInfo.filePaths.length === 0) {
          results.push({ slug, status: "skipped: source not found" });
          continue;
        }

        const provider = allProviders.find((p) => p.name === providerName);
        if (!provider) {
          results.push({ slug, status: `skipped: unknown provider ${providerName}` });
          continue;
        }

        // Re-parse and re-generate
        const paths = [...sessionInfo.filePaths, ...(sessionInfo.toolPaths || [])];
        const parsed = await provider.parse(paths, sessionInfo);
        const home = homedir();
        const project = sessionInfo.project.startsWith(home)
          ? `~${sessionInfo.project.slice(home.length)}`
          : sessionInfo.project;

        const replay = transformToReplay(parsed, providerName, project, {
          generator: {
            name: "vibe-replay",
            version: CLI_VERSION,
            generatedAt: new Date().toISOString(),
          },
        });

        // Preserve custom title from old replay
        if (oldReplay.meta?.title) replay.meta.title = oldReplay.meta.title;

        const outputDir = join(replaysDir, slug);
        await generateOutput(replay, outputDir);
        results.push({ slug, status: "regenerated", scenes: replay.scenes.length });
      } catch (err) {
        results.push({ slug, status: `error: ${getErrorMessage(err)}` });
      }
    }

    const updatedReplays = await refreshReplaysCache();
    if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);
    return c.json({
      total: results.length,
      regenerated: results.filter((r) => r.status === "regenerated").length,
      results,
    });
  });

  // --- Session scanner: background metadata extraction for insights ---

  app.post("/api/scan/start", async (c) => {
    startBackgroundScan();
    return c.json({ ok: true, message: "Background scan started" });
  });

  app.get("/api/scan/status", async (c) => {
    return c.json({
      running: scanState.running,
      scanned: scanState.scanned,
      total: scanState.total,
      resultCount: scanState.results.length,
      currentSession: scanState.currentSession,
      phase: scanState.phase,
      startedAt: scanState.startedAt,
      finishedAt: scanState.finishedAt,
      hasInsights: insightsCache.userInsights !== null,
      hasCachedResults: scanState.results.length > 0,
      cachedResultCount: scanState.results.length,
      cachedAt: scanState.finishedAt,
    });
  });

  app.get("/api/scan/results", async (c) => {
    return c.json({
      results: scanState.results,
      running: scanState.running,
      scanned: scanState.scanned,
      total: scanState.total,
    });
  });

  app.get("/api/insights", async (c) => {
    const project = c.req.query("project");

    if (project) {
      // Project-level: cache hit → O(1), miss → compute on demand
      const cached = insightsCache.projectInsights.get(project);
      if (cached) return c.json({ type: "project", insights: cached });

      // Fallback: compute on demand
      const scans = scanState.results;
      if (!scans.length) {
        return c.json({ error: "No scan results available. Start a scan first." }, 404);
      }
      const memory = await readProjectMemory(project);
      const insights = aggregateProjectInsights(project, scans, memory || undefined);
      insightsCache.projectInsights.set(project, insights);
      return c.json({ type: "project", insights });
    }

    // User-level: cache hit → O(1)
    if (insightsCache.userInsights) {
      return c.json({ type: "user", insights: insightsCache.userInsights });
    }

    // Fallback: compute on demand
    const scans = scanState.results;
    if (!scans.length) {
      return c.json({ error: "No scan results available. Start a scan first." }, 404);
    }
    const insights = aggregateUserInsights(scans);
    return c.json({ type: "user", insights });
  });

  // --- Local insights store (durable, survives source deletion) ---

  app.get("/api/insights/local", async (c) => {
    const store = await readInsightsStore();
    return c.json(store);
  });

  app.get("/api/insights/local/stats", async (c) => {
    const { getInsightsStats } = await import("./insights.js");
    const store = await readInsightsStore();
    return c.json(getInsightsStats(store));
  });

  app.post("/api/insights/sync", async (c) => {
    const result = await syncInsightsToCloud();
    if (result.error === "Not logged in") {
      return c.json({ error: "Not logged in. Run: vibe-replay auth login" }, 401);
    }
    if (result.error) {
      return c.json({
        error: `Sync failed: ${result.error}`,
        synced: result.synced,
        total: result.total,
      });
    }
    if (result.total === 0) {
      return c.json({ synced: 0, message: "All insights already synced" });
    }
    return c.json({
      synced: result.synced,
      total: result.total,
      message: `Synced ${result.synced} insights to cloud`,
    });
  });

  app.get("/api/memory", async (c) => {
    const project = c.req.query("project");
    if (!project) return c.json({ error: "project parameter required" }, 400);

    const memory = await readProjectMemory(project);
    if (!memory) return c.json({ memoryFiles: [], claudeMd: null });
    return c.json(memory);
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
    } catch (err) {
      return c.json({ error: `Failed to save annotations: ${getErrorMessage(err)}` }, 500);
    }
    return c.json({ ok: true });
  });

  // GitHub CLI status
  app.get("/api/gh-status", (c) => {
    return c.json(checkPublishStatus());
  });

  // Auth — read local auth.json (per-environment, keyed by API origin)
  // The BFF proxy follows the TOKEN, not the env var: if no token for the
  // current VIBE_REPLAY_API_URL, it uses whatever token is available and
  // proxies to that token's origin (e.g. production) instead.
  const cloudApiBaseUrl = getApiUrl().replace(/\/$/, "");

  function readLocalAuthSession(): {
    token: string;
    user: { id: string; name: string; email?: string; image?: string };
    /** The actual API origin this token authenticates against */
    targetApi: string;
  } | null {
    // 1. Try exact match for current environment
    const exact = loadAuthToken(cloudApiBaseUrl);
    if (exact) {
      return {
        token: exact.token,
        user: exact.user as { id: string; name: string; email?: string; image?: string },
        targetApi: cloudApiBaseUrl,
      };
    }
    // 2. Fallback: use any available token and proxy to its origin
    const fallback = loadAnyAuthToken();
    if (fallback) {
      return {
        token: fallback.token,
        user: fallback.user as { id: string; name: string; email?: string; image?: string },
        targetApi: fallback.origin.replace(/\/$/, ""),
      };
    }
    return null;
  }

  async function clearLocalAuthSession() {
    // Remove ALL tokens — user expects a full logout, not per-env
    for (const entry of loadAllAuthTokens()) {
      await removeAuthToken(entry.origin);
    }
    invalidateAuthCache();
  }

  /** Build an ordered list of (token, apiUrl) pairs to try.
   *  Exact match for current env first, then any other available token. */
  function getAuthCandidates(): { token: string; apiUrl: string }[] {
    const candidates: { token: string; apiUrl: string }[] = [];
    const exact = loadAuthToken(cloudApiBaseUrl);
    if (exact) candidates.push({ token: exact.token, apiUrl: cloudApiBaseUrl });
    const fallback = loadAnyAuthToken();
    if (fallback) {
      const fallbackApi = fallback.origin.replace(/\/$/, "");
      if (fallbackApi !== cloudApiBaseUrl) {
        candidates.push({ token: fallback.token, apiUrl: fallbackApi });
      }
    }
    return candidates;
  }

  async function fetchCloudApiWithLocalAuth(path: string, init: RequestInit = {}) {
    const candidates = getAuthCandidates();
    if (candidates.length === 0) return { unauthorized: true as const };

    // Try each candidate; on 401, cascade to the next one
    for (const candidate of candidates) {
      const headers = new Headers(init.headers);
      const cookieName = getSessionCookieName(candidate.apiUrl);
      headers.set("Cookie", `${cookieName}=${candidate.token}`);
      const response = await fetch(`${candidate.apiUrl}${path}`, { ...init, headers });
      if (response.status !== 401) return { unauthorized: false as const, response };
    }
    // All candidates returned 401 — token expired, clear it
    await clearLocalAuthSession();
    return { unauthorized: true as const };
  }

  // Track validated auth state so we don't hit the cloud on every request.
  // Invalidated on 401 from any cloud call or on explicit logout.
  let validatedAuth: { valid: boolean; checkedAt: number } | null = null;
  const AUTH_CHECK_TTL = 5 * 60 * 1000; // Re-validate every 5 minutes

  /** Validate the local token against the cloud. Caches result. */
  async function isAuthValid(): Promise<boolean> {
    const now = Date.now();
    if (validatedAuth && now - validatedAuth.checkedAt < AUTH_CHECK_TTL) {
      return validatedAuth.valid;
    }
    const auth = readLocalAuthSession();
    if (!auth) {
      validatedAuth = { valid: false, checkedAt: now };
      return false;
    }
    try {
      const cookieName = getSessionCookieName(auth.targetApi);
      const resp = await fetch(`${auth.targetApi}/api/auth/get-session`, {
        headers: { Cookie: `${cookieName}=${auth.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          // Auth rejected — clear session so UI shows logged out
          await clearLocalAuthSession();
          validatedAuth = { valid: false, checkedAt: now };
          return false;
        }
        // 5xx / other non-2xx — treat like network error (offline-friendly)
        validatedAuth = { valid: true, checkedAt: now };
        return true;
      }
      const data = await resp.json();
      const valid = !!(data?.session && data.user);
      if (!valid) {
        // Token expired — clear it so UI shows logged out
        await clearLocalAuthSession();
      }
      validatedAuth = { valid, checkedAt: now };
      return valid;
    } catch {
      // Network/timeout error — assume still valid (offline-friendly)
      validatedAuth = { valid: true, checkedAt: now };
      return true;
    }
  }

  /** Invalidate cached auth state (call on 401 or logout). */
  function invalidateAuthCache() {
    validatedAuth = null;
  }

  /** Shared response handler for cloud API proxy routes (BFF mode). */
  async function proxyCloudResponse(
    c: Context,
    cloudPath: string,
    errorLabel: string,
    init?: RequestInit,
  ) {
    try {
      const proxied = await fetchCloudApiWithLocalAuth(cloudPath, init);
      if (proxied.unauthorized) return c.json({ error: "Unauthorized" }, 401);
      const contentType = proxied.response.headers.get("content-type") || "";
      const status = proxied.response.status as ContentfulStatusCode;
      if (!contentType.includes("application/json")) {
        const text = await proxied.response.text();
        return c.body(text, status, { "Content-Type": contentType || "text/plain" });
      }
      const data = await proxied.response.json().catch(() => ({}));
      return c.json(data, status);
    } catch (err) {
      return c.json({ error: `${errorLabel}: ${getErrorMessage(err)}` }, 502);
    }
  }

  app.get("/api/auth/status", async (c) => {
    const auth = readLocalAuthSession();
    if (!auth) return c.json({ authenticated: false, user: null });
    const valid = await isAuthValid();
    if (!valid) return c.json({ authenticated: false, user: null });
    return c.json({ authenticated: true, user: auth.user || null });
  });

  // Better Auth-shaped local session endpoint for editor mode parity.
  app.get("/api/auth/get-session", async (c) => {
    const auth = readLocalAuthSession();
    if (!auth) return c.json({ session: null, user: null });
    const valid = await isAuthValid();
    if (!valid) return c.json({ session: null, user: null });
    return c.json({
      session: { token: auth.token },
      user: auth.user,
    });
  });

  app.post("/api/auth/logout", async (c) => {
    await clearLocalAuthSession();
    return c.json({ success: true });
  });

  // Alias for cloud worker parity; keep /api/auth/logout for backward compatibility
  app.post("/api/auth/sign-out", async (c) => {
    await clearLocalAuthSession();
    return c.json({ success: true });
  });

  // Auth login — start OAuth flow, return URL for browser to open
  app.post("/api/auth/login", async (c) => {
    const { randomUUID } = await import("node:crypto");
    const http = await import("node:http");

    const apiUrl = cloudApiBaseUrl;
    const nonce = randomUUID();

    // Start a temporary localhost server to receive the OAuth callback
    return new Promise<Response>((resolveResponse) => {
      let responded = false;
      const respond = (r: Response) => {
        if (responded) return;
        responded = true;
        resolveResponse(r);
      };

      const server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(200, {
            "Access-Control-Allow-Origin": apiUrl,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "POST" && req.url === "/callback") {
          let body = "";
          let destroyed = false;
          req.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_000_000) {
              destroyed = true;
              res.writeHead(413);
              res.end();
              req.destroy();
            }
          });
          req.on("end", async () => {
            if (destroyed) return;
            try {
              const data = JSON.parse(body);
              if (data.nonce !== nonce) {
                res.writeHead(403);
                res.end("Forbidden");
                server.close();
                return;
              }
              res.writeHead(200, {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": apiUrl,
              });
              res.end("OK");

              // Save auth keyed by current API environment
              await saveAuthToken({ token: data.token, user: data.user }, cloudApiBaseUrl);

              // Auto-sync insights to cloud after login (fire-and-forget)
              autoSyncInsights().catch(() => {});
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

      server.on("error", (err) => {
        respond(c.json({ error: `OAuth server failed: ${err.message}` }, 500));
        // Close the server so a post-listen error doesn't leak until the 5-minute timeout
        try {
          server.close();
        } catch {
          /* already closed */
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          respond(c.json({ error: "Failed to get server address" }, 500));
          return;
        }
        const loginUrl = `${apiUrl}/auth/cli-login?port=${addr.port}&nonce=${nonce}`;
        respond(c.json({ url: loginUrl }));
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

  // Proxy cloud APIs via local auth session (BFF mode for editor)
  // This keeps pnpm dev/start/npx behavior consistent and avoids cross-site cookie issues.
  app.get("/api/cloud-replays", async (c) => {
    return proxyCloudResponse(c, "/api/cloud-replays", "Cloud API unavailable");
  });

  app.post("/api/cloud-replays", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(c, "/api/cloud-replays", "Cloud upload failed", {
      method: "POST",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
    });
  });

  app.delete("/api/cloud-replays/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
      return c.json({ error: "Invalid replay ID" }, 400);
    }
    return proxyCloudResponse(c, `/api/cloud-replays/${id}`, "Cloud delete failed", {
      method: "DELETE",
    });
  });

  // Proxy user file APIs via local auth session (BFF mode for editor)
  app.post("/api/files", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(c, "/api/files", "File upload failed", {
      method: "POST",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
    });
  });

  app.get("/api/files", async (c) => {
    return proxyCloudResponse(c, "/api/files", "File list failed");
  });

  app.delete("/api/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
      return c.json({ error: "Invalid file ID" }, 400);
    }
    return proxyCloudResponse(c, `/api/files/${id}`, "File delete failed", {
      method: "DELETE",
    });
  });

  app.post("/api/gists", async (c) => {
    const body = await c.req.text();
    return proxyCloudResponse(c, "/api/gists", "Gist publish failed", {
      method: "POST",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
    });
  });

  app.patch("/api/gists/:gistId", async (c) => {
    const gistId = c.req.param("gistId");
    if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
      return c.json({ error: "Invalid gist ID" }, 400);
    }
    const body = await c.req.text();
    return proxyCloudResponse(c, `/api/gists/${gistId}`, "Gist update failed", {
      method: "PATCH",
      headers: { "Content-Type": c.req.header("content-type") || "application/json" },
      body,
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

  // Delete stale gist info (gist deleted on GitHub)
  app.delete("/api/gist-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const metaPath = join(baseDir, result.slug, ".vibe-replay-gist.json");
    await unlink(metaPath).catch(() => {});
    return c.json({ ok: true });
  });

  // Cloud info for a session (requires slug)
  app.get("/api/cloud-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);
    const cloud = await loadSavedCloudInfo(targetDir);
    if (!cloud) return c.json({ cloud: null });
    return c.json({ cloud });
  });

  // Save cloud info locally (after browser-side upload)
  app.post("/api/cloud-info", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
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
    const metaPath = join(baseDir, result.slug, ".vibe-replay-cloud.json");
    await unlink(metaPath).catch(() => {});
    return c.json({ ok: true });
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

  // Publish to cloud (R2) — overlay merging is handled by publishCloudWithOverlays
  app.post("/api/publish/cloud", async (c) => {
    const result = requireSlug(c.req.query("slug"));
    if ("error" in result) return c.json({ error: result.error }, 400);
    const targetDir = join(baseDir, result.slug);

    try {
      const body = await c.req.json().catch(() => ({}));
      const cloudResult = await publishCloudWithOverlays(targetDir, {
        visibility: body.visibility || "unlisted",
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
      const body: { toolName?: string } = await c.req
        .json<{ toolName?: string }>()
        .catch(() => ({}));
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
        outcome: fb.result.outcome,
        sessionGoal: fb.result.sessionGoal,
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
    } catch (err) {
      return c.json({ error: `Failed to save overlays: ${getErrorMessage(err)}` }, 500);
    }
    return c.json({ ok: true });
  });

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
      const body: { toolName?: string; targetLang?: string; sourceLang?: string } = await c.req
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
      const body: { toolName?: string; style?: string } = await c.req
        .json<{ toolName?: string; style?: string }>()
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
      if (opts?.openLive) {
        const qp = new URLSearchParams({
          live: "1",
          provider: opts.openLive.provider,
          sessionId: opts.openLive.sessionId,
        });
        browseUrl = `${viewerBase}/?${qp.toString()}`;
      } else if (opts?.openDashboard) {
        browseUrl = `${viewerBase}/?view=dashboard`;
      } else if (opts?.openSlug) {
        browseUrl = `${viewerBase}/?session=${encodeURIComponent(opts.openSlug)}`;
      } else {
        browseUrl = `${viewerBase}/?view=dashboard`;
      }

      const label = opts?.openLive
        ? "Live"
        : opts?.openDashboard || !opts?.openSlug
          ? "Dashboard"
          : "Editor";
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
  buildSourcesResult,
  buildInsightsSyncBatches,
  countSessionStats,
  pickSourceRecordForSession,
  selectCursorEnrichmentCandidates,
  sourceSessionKey,
};
