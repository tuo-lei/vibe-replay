import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  contentRevision,
  readSavedReplay,
  applySavedEdits,
  resolveSessionReference,
  SessionReferenceError,
} from "./session-workflows.js";
import { querySessionPage, type SessionQueryOptions } from "./session-query.js";
import type { ReplaySession, SessionInfo } from "./types.js";

interface SavedDetails {
  origin: "snapshot";
  replayPath: string;
  status: "ready" | "invalid-sidecar" | "unreadable";
  revision?: string;
  sceneCount: number;
  annotationCount?: number;
  editedSceneCount?: number;
  error?: string;
}

/** Saved snapshots are discoverable independently of deleted or unavailable providers. */
export async function querySavedReplays(
  options: Omit<SessionQueryOptions, "scan" | "brief" | "dedupe"> & {
    target?: string;
    session?: string;
  } = {},
  baseDir = join(homedir(), ".vibe-replay"),
) {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const issues: Array<{ path: string; code: "unreadable-replay" }> = [];
  const details = new Map<string, SavedDetails>();
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(baseDir, entry.name);
        const path = join(directory, "replay.json");
        let raw: ReplaySession;
        let modified: string;
        try {
          raw = await readSavedReplay(directory);
          modified = (await stat(path)).mtime.toISOString();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            issues.push({ path, code: "unreadable-replay" });
          return undefined;
        }
        if (options.provider && raw.meta.provider !== options.provider) return undefined;
        if (
          options.target &&
          (raw.meta.location?.kind === "ssh" ? raw.meta.location.id : "local") !== options.target
        )
          return undefined;
        let effective: ReplaySession | undefined;
        let errorCode: SavedDetails["status"] = "ready";
        let errorMessage: string | undefined;
        try {
          effective = await applySavedEdits(raw, directory);
        } catch (error) {
          errorCode =
            (error as { code?: string }).code === "invalid-sidecar"
              ? "invalid-sidecar"
              : "unreadable";
          errorMessage =
            "Saved content could not be safely loaded. Restore a valid backup before inspecting or sharing.";
        }
        // Never reveal original prompts when saved edits could not be applied safely.
        const prompts = effective?.scenes
          .filter((scene) => scene.type === "user-prompt")
          .slice(0, 2)
          .map((scene) => scene.content.slice(0, 500));
        const item: SessionInfo = {
          provider: raw.meta.provider,
          sessionId: raw.meta.sessionId,
          slug: entry.name,
          title: effective?.meta.title,
          location: raw.meta.location,
          project: raw.meta.project || raw.meta.cwd || "",
          cwd: raw.meta.cwd || "",
          version: raw.meta.generator?.version || "",
          timestamp:
            raw.meta.generator?.generatedAt || raw.meta.endTime || raw.meta.startTime || modified,
          filePath: path,
          filePaths: [path],
          lineCount: 0,
          fileSize: 0,
          firstPrompt: prompts?.[0] || "",
          prompts,
          promptCount: effective?.meta.stats?.userPrompts,
          toolCallCount: effective?.meta.stats?.toolCalls,
          compactionCount: effective?.meta.compactions?.length,
        };
        details.set(path, {
          origin: "snapshot",
          replayPath: path,
          status: errorCode,
          sceneCount: raw.scenes.length,
          error: errorMessage,
          ...(effective
            ? {
                revision: contentRevision(effective),
                annotationCount: effective.annotations?.length || 0,
                editedSceneCount: effective.scenes.filter(
                  (scene, index) =>
                    "content" in scene &&
                    scene.content !== (raw.scenes[index] as { content?: string }).content,
                ).length,
              }
            : {}),
        });
        return item;
      }),
  );
  let sessions = found.filter((item): item is SessionInfo => item !== undefined);
  if (options.session) {
    try {
      sessions = [resolveSessionReference(sessions, options.session, options)];
    } catch (error) {
      if (error instanceof SessionReferenceError) {
        error.message =
          error.code === "not-found"
            ? `Saved replay '${options.session}' not found. Run 'vibe-replay replays --json' or broaden the saved replay filters.`
            : `${error.message} Use a replayPath from 'vibe-replay replays --json' to select the exact snapshot.`;
        Object.assign(error, { suggestions: ["vibe-replay replays --json"] });
      }
      throw error;
    }
  }
  const { query, project, provider, limit, offset, revision, any, compacted } = options;
  const page = await querySessionPage(sessions, {
    query,
    project,
    provider,
    limit,
    offset,
    revision,
    any,
    compacted,
  });
  return {
    replays: page.sessions.map((session) => ({ ...session, ...details.get(session.filePath)! })),
    pagination: page.pagination,
    partial: issues.length > 0 || [...details.values()].some((item) => item.status !== "ready"),
    issues: issues.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
