import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { readGitRepo, shortenPath } from "@vibe-replay/provider-core/utils";
import { generateOutput } from "../generator.js";
import { getAllProviders, getProvider } from "../providers/index.js";
import { discoverProvidersSafely } from "../provider-discovery.js";
import { getRemoteHome } from "../remote.js";
import { scanForSecrets } from "../scan.js";
import { mergeSameSessions } from "../session-merge.js";
import {
  getErrorMessage,
  hasReplayableContent,
  replayOutputSlug,
  resolveGenerateInputs,
  safeSlug,
} from "../server-core.js";
import { transformToReplay } from "../transform.js";
import { normalizeTitle } from "../utils.js";
import { CLI_VERSION } from "../version.js";
import type { SessionInfo } from "../types.js";
import type { GenerateRequestBody } from "../server-core.js";
import type { ReplaySummary } from "../server-types.js";

interface GenerationRouteDeps {
  baseDir: string;
  discoverAllProviders: () => Promise<{ sessions: SessionInfo[] }>;
  refreshReplaysCache: () => Promise<ReplaySummary[] | null>;
  syncSourcesCacheWithReplays: (replays: ReplaySummary[]) => Promise<void>;
}

/** Replay generation and regeneration routes. */
export function registerGenerationRoutes(app: Hono, deps: GenerationRouteDeps): void {
  const { baseDir, discoverAllProviders, refreshReplaysCache, syncSourcesCacheWithReplays } = deps;

  app.post("/api/generate", async (c) => {
    try {
      const body = await c.req.json<GenerateRequestBody>();

      const provider = getProvider(body.provider);
      if (!provider) {
        return c.json({ error: `Unknown provider: ${body.provider}` }, 400);
      }

      let discoveredSessions: SessionInfo[] = [];
      if (typeof body.sessionSlug === "string" && safeSlug(body.sessionSlug)) {
        discoveredSessions = mergeSameSessions(
          (await discoverProvidersSafely([provider])).sessions,
        );
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
      const project = shortenPath(rawProject, home);
      const gitRepo =
        resolved.value.sessionInfo?.gitRepo ||
        (resolved.value.sessionInfo?.location?.kind === "ssh"
          ? undefined
          : await readGitRepo(rawProject));

      const replay = transformToReplay(parsed, body.provider, project, {
        generator: {
          name: "vibe-replay",
          version: CLI_VERSION,
          generatedAt: new Date().toISOString(),
        },
        gitRepo,
        location: resolved.value.sessionInfo?.location,
        remoteHome: getRemoteHome(
          resolved.value.sessionInfo?.location?.kind === "ssh"
            ? resolved.value.sessionInfo.location.id
            : undefined,
        ),
      });
      if (!hasReplayableContent(replay)) {
        return c.json({ error: "This session has no replayable user prompts" }, 422);
      }

      if (typeof body.title === "string") {
        const normalizedCustomTitle = normalizeTitle(body.title);
        if (normalizedCustomTitle) {
          replay.meta.title = normalizedCustomTitle;
        }
      }

      const rawSlug = replay.meta.slug || replay.meta.sessionId.slice(0, 8);
      const slug = replayOutputSlug(rawSlug, resolved.value.sessionInfo?.location, {
        provider: body.provider,
        sessionId: replay.meta.sessionId,
      });
      const outputDir = join(baseDir, slug);
      await generateOutput(replay, outputDir);
      const updatedReplays = await refreshReplaysCache();
      if (updatedReplays) await syncSourcesCacheWithReplays(updatedReplays);

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

  app.post("/api/regenerate-all", async (c) => {
    const replaysDir = baseDir;
    const results: Array<{ slug: string; status: string; scenes?: number }> = [];

    const allProviders = getAllProviders();
    const allSessions = mergeSameSessions((await discoverAllProviders()).sessions);

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
        const raw = await readFile(replayPath, "utf-8").catch(() => null);
        if (!raw) continue;

        const oldReplay = JSON.parse(raw);
        const sessionId = oldReplay.meta?.sessionId;
        const providerName = oldReplay.meta?.provider || "claude-code";
        if (!sessionId) {
          results.push({ slug, status: "skipped: no sessionId" });
          continue;
        }

        const replayTargetId =
          oldReplay.meta?.location?.kind === "ssh" && typeof oldReplay.meta.location.id === "string"
            ? oldReplay.meta.location.id
            : undefined;
        const sessionInfo = allSessions.find((s) => {
          const sessionTargetId = s.location?.kind === "ssh" ? s.location.id : undefined;
          return (
            s.provider === providerName &&
            s.sessionId === sessionId &&
            sessionTargetId === replayTargetId
          );
        });
        if (!sessionInfo || sessionInfo.filePaths.length === 0) {
          results.push({
            slug,
            status: sessionInfo?.transcriptStatus
              ? `skipped: ${sessionInfo.transcriptStatus}`
              : "skipped: source not found",
          });
          continue;
        }
        if (sessionInfo.transcriptStatus) {
          results.push({ slug, status: `skipped: ${sessionInfo.transcriptStatus}` });
          continue;
        }

        const provider = allProviders.find((p) => p.name === providerName);
        if (!provider) {
          results.push({ slug, status: `skipped: unknown provider ${providerName}` });
          continue;
        }

        const paths = [...sessionInfo.filePaths, ...(sessionInfo.toolPaths || [])];
        const parsed = await provider.parse(paths, sessionInfo);
        const home = homedir();
        const project = shortenPath(sessionInfo.project, home);

        const replay = transformToReplay(parsed, providerName, project, {
          generator: {
            name: "vibe-replay",
            version: CLI_VERSION,
            generatedAt: new Date().toISOString(),
          },
          gitRepo: sessionInfo.gitRepo,
          location: sessionInfo.location,
          transcriptStatus: sessionInfo.transcriptStatus,
          remoteHome: getRemoteHome(
            sessionInfo.location?.kind === "ssh" ? sessionInfo.location.id : undefined,
          ),
        });
        if (!hasReplayableContent(replay)) {
          results.push({ slug, status: "skipped: no replayable user prompts" });
          continue;
        }

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
}
