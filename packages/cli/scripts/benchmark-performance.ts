import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { SqliteSnapshotRequiredError, withReadOnlySqlite } from "@vibe-replay/provider-core/utils";
import { deduplicateSessionsByProvider, getAllProviders } from "../src/providers/index.js";
import { exportSession } from "../src/session-workflows.js";
import { mergeSameSessions } from "../src/session-merge.js";
import { scanInputFromSession } from "../src/session-query.js";
import { runBackgroundScan } from "../src/scanner.js";
import { transformToReplay } from "../src/transform.js";

// Explicit consent: this command reads real local histories, and never contacts SSH sources.
if (!process.argv.includes("--read-local-sessions")) {
  throw new Error("Pass --read-local-sessions to benchmark your local histories. Build first.");
}
process.env.VIBE_REPLAY_DISABLE_FILE_CACHE = "1";
const emit = (value: object) => console.log(JSON.stringify(value));
const started = performance.now();
let firstUsableMs: number | undefined;
const discovered = await withReadOnlySqlite(true, () =>
  Promise.all(
    getAllProviders().map(async (provider) => {
      const start = performance.now();
      let sessions: SessionInfo[];
      let status = "ready";
      try {
        sessions = await provider.discover({ readOnly: true });
        if (!sessions.length) status = "empty";
      } catch (error) {
        sessions = error instanceof SqliteSnapshotRequiredError ? error.sessions : [];
        status = error instanceof SqliteSnapshotRequiredError ? "checkpoint-required" : "failed";
      }
      if (
        status === "ready" &&
        firstUsableMs === undefined &&
        sessions.some(
          (session) => !session.transcriptStatus && (session.promptCount || session.firstPrompt),
        )
      )
        firstUsableMs = performance.now() - started;
      const sizes = sessions.map((session) => session.fileSize).sort((a, b) => a - b);
      emit({
        provider: provider.name,
        status,
        count: sessions.length,
        elapsedMs: performance.now() - start,
        sourceBytes: sizes.reduce((sum, size) => sum + size, 0),
        p50Bytes: sizes[Math.floor(sizes.length * 0.5)] || 0,
        p90Bytes: sizes[Math.floor(sizes.length * 0.9)] || 0,
        maxBytes: sizes.at(-1) || 0,
        unavailableCount: sessions.filter((session) => session.transcriptStatus).length,
      });
      return sessions;
    }),
  ),
);
const sessions = mergeSameSessions(deduplicateSessionsByProvider(discovered.flat()));
emit({
  phase: "discovery",
  appCache: "disabled",
  osCache: "not-flushed",
  firstUsableMs,
  completeMs: performance.now() - started,
  count: sessions.length,
});
if (process.argv.includes("--scan")) {
  const start = performance.now();
  const results = await withReadOnlySqlite(true, () =>
    runBackgroundScan(
      sessions.map((session) => ({ ...scanInputFromSession(session), deferRichCursorParse: true })),
    ),
  );
  emit({ phase: "rich-scan", elapsedMs: performance.now() - start, count: results.length });
}

const readable = sessions
  .filter(
    (session) =>
      !session.transcriptStatus &&
      session.fileSize > 0 &&
      (session.promptCount || session.firstPrompt),
  )
  .sort((a, b) => a.fileSize - b.fileSize);
const outputRoot = await mkdtemp(join(tmpdir(), "vibe-replay-performance-"));
async function exportOne(info: SessionInfo, index: number) {
  const start = performance.now();
  const parsed = await withReadOnlySqlite(true, () =>
    getAllProviders()
      .find((provider) => provider.name === info.provider)!
      .parse([...info.filePaths, ...(info.toolPaths || [])], info),
  );
  const parseMs = performance.now() - start;
  const replay = transformToReplay(parsed, info.provider, info.project);
  const transformMs = performance.now() - start - parseMs;
  const exportStart = performance.now();
  await exportSession(replay, join(outputRoot, String(index)), "html");
  return {
    provider: info.provider,
    sourceBytes: info.fileSize,
    scenes: replay.scenes.length,
    parseMs,
    transformMs,
    exportMs: performance.now() - exportStart,
    totalMs: performance.now() - start,
    scenesHash: createHash("sha256").update(JSON.stringify(replay.scenes)).digest("hex"),
  };
}
try {
  if (readable.length) {
    emit({
      phase: "typical-export",
      ...(await exportOne(readable[Math.floor(readable.length * 0.5)], 0)),
    });
    emit({ phase: "large-export", ...(await exportOne(readable.at(-1)!, 1)) });
    if (process.argv.includes("--batch")) {
      const start = performance.now();
      const results = [];
      for (const fraction of [0.25, 0.5, 0.75, 0.9, 1])
        results.push(
          await exportOne(
            readable[Math.min(readable.length - 1, Math.floor(readable.length * fraction))],
            results.length + 2,
          ),
        );
      emit({
        phase: "batch-export",
        count: results.length,
        elapsedMs: performance.now() - start,
        results,
      });
    }
  }
} finally {
  // Only delete this command's private temporary exports, never source histories.
  await rm(outputRoot, { recursive: true, force: true });
}
