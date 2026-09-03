import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readGitRepo, shortenPath } from "@vibe-replay/provider-core/utils";
import { classifyProject } from "@vibe-replay/types";
import { cleanPromptText, previewPrompt } from "./clean-prompt.js";
import { computeDaysUntilCleanup } from "./cleanup-warning.js";
import { loadSavedCloudInfo } from "./publishers/cloud.js";
import { loadSavedGistInfo, type SavedGistInfo } from "./publishers/gist.js";
import {
  pickSourceRecordForSession,
  providerSessionKey,
  sourceSessionKey,
} from "./server-enrichment.js";
import { loadAnnotations } from "./server-persistence.js";
import {
  cachedReplaySummary,
  findReplayForSource,
  providerSlugCounts,
  buildReplayMaps,
} from "./server-replay-matching.js";
import type { ReplaySummary, SourceSummaryRecord } from "./server-types.js";
import type { ReplaySession, SessionInfo } from "./types.js";
import { normalizeTitle } from "./utils.js";
import { CLI_VERSION } from "./version.js";

const replayGitRepoByProjectCache = new Map<string, string | undefined>();

async function readReplayGitRepo(project: string): Promise<string | undefined> {
  if (!replayGitRepoByProjectCache.has(project)) {
    replayGitRepoByProjectCache.set(project, await readGitRepo(project));
  }
  return replayGitRepoByProjectCache.get(project);
}

/** Scan replay.json files from a single directory. */
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
      const targetId = session.meta.location?.kind === "ssh" ? session.meta.location.id : undefined;
      const annotationCount = (await loadAnnotations(baseDir, entry, targetId)).length;

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
      let gitRepo = session.meta.gitRepo;
      if (!gitRepo && session.meta.project && session.meta.location?.kind !== "ssh") {
        gitRepo = await readReplayGitRepo(session.meta.project);
      }

      results.push({
        slug: entry,
        sourceSlug: session.meta.slug,
        baseDir,
        sessionId: session.meta.sessionId,
        title: session.meta.title,
        provider: session.meta.provider,
        location: session.meta.location,
        transcriptStatus: session.meta.transcriptStatus,
        model: session.meta.model,
        gitRepo,
        project: session.meta.project,
        startTime: session.meta.startTime,
        endTime: session.meta.endTime,
        stats: session.meta.stats,
        contextBreakdown: session.meta.contextBreakdown,
        compactionCount: session.meta.compactions?.length || 0,
        compactions: session.meta.compactions,
        apiErrors: session.meta.apiErrors,
        diagnostics: session.meta.diagnostics,
        diagnosticNotes: session.meta.diagnosticNotes,
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
                  outdated = currentHash !== gist.contentHash;
                } catch {
                  /* ignore */
                }
              }
              return {
                gistId: gist.gistId,
                viewerUrl: gist.viewerUrl,
                updatedAt: gist.updatedAt,
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
    } catch {
      // Ignore unreadable replay directories and continue scanning.
    }
  }

  return results;
}

/** Scan the primary replay directory and the backwards-compatible CWD fallback. */
export async function scanSessions(baseDir: string): Promise<ReplaySummary[]> {
  const dirs = [baseDir];
  const cwdLocal = resolve("./vibe-replay");
  if (cwdLocal !== baseDir) dirs.push(cwdLocal);

  const allResults: ReplaySummary[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const results = await scanSessionsFromDir(dir);
    for (const result of results) {
      const locationKey = result.location?.kind === "ssh" ? result.location.id : "local";
      const replayKey = `${locationKey}\0${result.slug}`;
      if (!seen.has(replayKey)) {
        seen.add(replayKey);
        allResults.push(result);
      }
    }
  }
  allResults.sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  return allResults;
}

/** Load a session by slug and attach persisted annotations. */
export async function loadSessionFromDisk(
  baseDir: string,
  slug: string,
  targetId?: string,
): Promise<ReplaySession> {
  let replayPath = join(baseDir, slug, "replay.json");
  try {
    await stat(replayPath);
  } catch {
    const fallback = resolve("./vibe-replay", slug, "replay.json");
    await stat(fallback);
    replayPath = fallback;
  }
  const raw = await readFile(replayPath, "utf-8");
  const session = JSON.parse(raw) as ReplaySession;
  const sessionTargetId =
    session.meta.location?.kind === "ssh" ? session.meta.location.id : undefined;
  if (sessionTargetId !== targetId) {
    throw new Error("Session does not belong to the requested SSH source");
  }
  const annotations = await loadAnnotations(baseDir, slug, targetId);
  if (annotations.length > 0) session.annotations = annotations;
  return session;
}

export function normalizeSessionProjectsForHome(
  sessions: SessionInfo[],
  home: string,
): SessionInfo[] {
  return sessions.map((session) => ({ ...session, project: shortenPath(session.project, home) }));
}

export function isFilesystemProjectKey(project: string): boolean {
  return (
    project === "~" ||
    project.startsWith("~/") ||
    project.startsWith("~\\") ||
    project.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(project)
  );
}

export async function buildSourcesResult(
  merged: SessionInfo[],
  baseDir: string,
  home: string,
  previousSources: SourceSummaryRecord[] = [],
  cleanupPeriodDays = 0,
): Promise<SourceSummaryRecord[]> {
  for (const session of merged) session.project = shortenPath(session.project, home);

  const uniqueProjects = [...new Set(merged.map((session) => session.project))];
  const projectExistsMap = new Map<string, boolean>();
  const projectIsGitMap = new Map<string, boolean>();
  for (const project of uniqueProjects) {
    if (
      !merged.some((session) => session.project === project && session.location?.kind !== "ssh")
    ) {
      continue;
    }
    const resolved =
      project === "~"
        ? home
        : project.startsWith("~/") || project.startsWith("~\\")
          ? join(home, project.slice(2))
          : project;
    try {
      const projectStat = await stat(resolved);
      projectExistsMap.set(project, projectStat.isDirectory());
      if (projectStat.isDirectory()) {
        try {
          await stat(join(resolved, ".git"));
          projectIsGitMap.set(project, true);
        } catch {
          projectIsGitMap.set(project, false);
        }
      }
    } catch {
      projectExistsMap.set(project, false);
    }
  }

  const existingReplays = await scanSessions(baseDir);
  const replayMaps = buildReplayMaps(existingReplays);
  const sourceSlugCounts = providerSlugCounts(merged);
  const previousBySessionId = new Map<string, SourceSummaryRecord>();
  const previousByKey = new Map<string, SourceSummaryRecord>();
  for (const previous of previousSources) {
    const targetId = previous.location?.kind === "ssh" ? previous.location.id : undefined;
    previousByKey.set(
      sourceSessionKey(previous.provider, previous.project, previous.slug, targetId),
      previous,
    );
    if (typeof previous.sessionId === "string" && previous.sessionId) {
      previousBySessionId.set(
        providerSessionKey(previous.provider, previous.sessionId, targetId),
        previous,
      );
    }
  }

  return merged.map((session) => {
    const previous = pickSourceRecordForSession(session, previousBySessionId, previousByKey);
    const replay = findReplayForSource(session, replayMaps, sourceSlugCounts);
    const promptCount = session.promptCount ?? previous?.promptCount;
    const toolCallCount = session.toolCallCount ?? previous?.toolCallCount;
    const gitRepo =
      session.gitRepo ?? (typeof previous?.gitRepo === "string" ? previous.gitRepo : undefined);
    const projectIdentity =
      session.projectIdentity ||
      classifyProject(session.project, {
        provider: session.provider,
        hasSdk: session.hasSdk,
        sdkWorkspaceRef: session.workspacePath,
        gitRepo,
      });
    return {
      provider: session.provider,
      location: session.location,
      transcriptStatus: session.transcriptStatus,
      sessionId: session.sessionId,
      slug: session.slug,
      title: normalizeTitle(
        cleanPromptText(typeof session.title === "string" ? session.title : ""),
      ),
      project: session.project,
      projectIdentity,
      timestamp: session.timestamp,
      fileSize: session.fileSize,
      lineCount: session.lineCount,
      promptCount,
      toolCallCount,
      firstPrompt: previewPrompt(session.firstPrompt),
      prompts: session.prompts?.map((prompt) => previewPrompt(prompt)),
      filePaths: session.filePaths,
      toolPaths: session.toolPaths,
      hasSqlite: session.hasSqlite,
      hasSdk: session.hasSdk,
      sourceFingerprint: session.sourceFingerprint,
      gitBranch: session.gitBranch,
      gitRepo,
      model: session.model,
      durationMsEst: session.durationMsEst,
      editCountEst: session.editCountEst,
      compactionCount: session.compactionCount,
      hasPR: session.hasPR,
      isStarred: session.isStarred,
      spaceId: session.spaceId,
      spaceIdSetBy: session.spaceIdSetBy,
      pluginsEnabled: session.pluginsEnabled,
      skillsEnabled: session.skillsEnabled,
      fsDetectedFiles: session.fsDetectedFiles,
      expiresInDays:
        session.provider === "claude-code" && cleanupPeriodDays > 0
          ? computeDaysUntilCleanup(session.timestamp, cleanupPeriodDays)
          : undefined,
      existingReplay: replay ? replay.slug : null,
      projectExists:
        session.location?.kind === "ssh"
          ? undefined
          : (projectExistsMap.get(session.project) ?? false),
      isGitRepo:
        session.location?.kind === "ssh"
          ? undefined
          : (projectIsGitMap.get(session.project) ?? false),
      replay: replay ? cachedReplaySummary(replay) : undefined,
    };
  });
}
