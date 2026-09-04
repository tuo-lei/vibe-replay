import { type FSWatcher, watch as fsWatch } from "node:fs";
import { open as fsOpen, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { parseClaudeCodeLines } from "../providers/claude-code/parser.js";
import { parseCodexLines } from "../providers/codex/parser.js";
import { parsePiLines } from "../providers/pi/parser.js";
import {
  readCursorLiveDiagnostics,
  resolveCursorLiveWatchPaths,
} from "../providers/cursor/sqlite-reader.js";
import { getProvider } from "../providers/index.js";
import { mergeSameSessions } from "../session-merge.js";
import { getErrorMessage, safeTargetId } from "../server-core.js";
import { transformToReplay } from "../transform.js";
import type { SessionInfo } from "../types.js";
import { CLI_VERSION } from "../version.js";

type LiveSessionState = "busy" | "idle" | "stopped" | "unknown";

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
    if (typeof data.pid !== "number" || !data.status) continue;

    let alive = false;
    try {
      process.kill(data.pid, 0);
      alive = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") alive = true;
    }
    if (alive) return data.status === "busy" ? "busy" : "idle";
  }
  return "stopped";
}

/** Stream a provider session while its source files are changing. */
export function registerLiveRoutes(app: Hono): void {
  app.get("/api/live", (c) => {
    const providerName = c.req.query("provider") || "";
    const sessionId = c.req.query("sessionId") || "";
    const targetId = safeTargetId(c.req.query("targetId"));

    return streamSSE(c, async (stream) => {
      const sendError = async (message: string) => {
        await stream.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      };

      if (!providerName || !sessionId) {
        await sendError("provider and sessionId query parameters are required");
        return;
      }
      if (targetId === null) {
        await sendError("invalid targetId");
        return;
      }
      if (targetId !== undefined) {
        await sendError("Live mode is unavailable for SSH sources");
        return;
      }

      const provider = getProvider(providerName);
      if (!provider) {
        await sendError(`Unknown provider: ${providerName}`);
        return;
      }

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
      const projectFor = (info: SessionInfo): string => shortenPath(info.project, home);

      const watchers: FSWatcher[] = [];
      const watchedPaths = new Set<string>();
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let aborted = false;
      let inFlight = false;
      let dirty = false;
      let lastSignature: string | null = null;
      let lastCursorDiagnosticsSignature: string | null = null;
      const isClaudeProvider = providerName === "claude-code";
      const isCursorProvider = providerName === "cursor";
      const isCodexProvider = providerName === "codex";
      const isPiProvider = providerName === "pi";
      const isGrokBotProvider = providerName === "grok-bot";
      const isJsonlLiveProvider =
        isClaudeProvider || isCodexProvider || isPiProvider || isGrokBotProvider;
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
          // Polling below remains the fallback for SQLite-backed sessions.
        }
      };

      const RESOLVE_REFRESH_INTERVAL_MS = 15_000;
      let lastResolvedAt = Date.now();
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
          jsonlTail.delete(filePath);
          return cached?.lines ?? [];
        }

        if (!cached || size < cached.offset) {
          const content = await readFile(filePath);
          const { lines, partial } = splitDecodedLines(content);
          jsonlTail.set(filePath, { offset: content.length, partial, lines });
          return lines;
        }

        if (size === cached.offset) return cached.lines;

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
          if (Date.now() - lastResolvedAt >= RESOLVE_REFRESH_INTERVAL_MS) {
            const fresh = await resolveSessionInfo();
            if (fresh) sessionInfo = fresh;
            lastResolvedAt = Date.now();
          }
          const info = sessionInfo!;
          const paths = [...info.filePaths, ...(info.toolPaths || [])];
          ensureWatchersFor(paths);
          await ensureCursorDbWatchersFor(info);
          const cursorDiagnostics =
            isCursorProvider && info.hasSqlite
              ? await readCursorLiveDiagnostics(info.sessionId).catch(() => null)
              : null;
          if (
            cursorDiagnostics &&
            lastCursorDiagnosticsSignature === cursorDiagnostics.signature &&
            lastSignature !== null
          ) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "diagnostics",
                cursorDiagnostics,
                cursorRowsChanged: false,
              }),
            });
            return;
          }
          let parsed;
          if (isJsonlLiveProvider) {
            const allLines: string[] = [];
            for (const fp of paths) {
              const lines = await tailReadJsonl(fp);
              allLines.push(...lines);
            }
            parsed = isClaudeProvider
              ? await parseClaudeCodeLines(allLines, { subagentsSourcePath: paths[0] })
              : isCodexProvider
                ? parseCodexLines(allLines, info, paths)
                : parsePiLines(allLines, { sourcePath: paths[0], sessionInfo: info });
          } else {
            parsed = await provider.parse(paths, info);
          }
          const replay = transformToReplay(parsed, providerName, projectFor(info), {
            generator: {
              name: "vibe-replay",
              version: CLI_VERSION,
              generatedAt: new Date().toISOString(),
            },
            gitRepo: info.gitRepo,
          });
          if (isClaudeProvider) lastLiveState = await readClaudeSessionState(sessionId);
          const signature = JSON.stringify(replay.scenes);
          if (cursorDiagnostics) lastCursorDiagnosticsSignature = cursorDiagnostics.signature;
          if (signature !== lastSignature) {
            lastSignature = signature;
            await stream.writeSSE({
              data: JSON.stringify({
                type: "session",
                session: replay,
                state: lastLiveState,
                ...(cursorDiagnostics ? { cursorDiagnostics, cursorRowsChanged: true } : {}),
              }),
            });
          } else if (cursorDiagnostics) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "diagnostics",
                cursorDiagnostics,
                cursorRowsChanged: true,
              }),
            });
          }
        } catch (err) {
          if (!aborted) {
            await stream
              .writeSSE({ data: JSON.stringify({ type: "error", message: getErrorMessage(err) }) })
              .catch(() => {});
          }
        } finally {
          inFlight = false;
          if (dirty && !aborted) {
            dirty = false;
            scheduleRebuild(0);
          }
        }
      };

      const scheduleRebuild = (delay = 100) => {
        if (aborted) return;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void buildAndSend();
        }, delay);
      };

      await buildAndSend();

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

      const pingInterval = setInterval(() => {
        if (aborted) return;
        stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {});
      }, 25_000);

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
              // Retry on the next poll.
            }
          }, 2_000)
        : null;

      const rediscoverInterval = setInterval(() => {
        if (aborted) return;
        scheduleRebuild(0);
      }, RESOLVE_REFRESH_INTERVAL_MS);

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
              // Ignore close errors during teardown.
            }
          }
          resolve();
        });
      });
    });
  });
}
