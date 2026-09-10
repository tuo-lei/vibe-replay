import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "@vibe-replay/provider-contract";

export const BUNDLED_SAMPLE_SESSION_ID = "vibe-replay-sample-welcome";
const BUNDLED_SAMPLE_SLUG = "welcome-sample";
const BUNDLED_SAMPLE_TIMESTAMP = "2026-09-01T12:00:05.000Z";
const BUNDLED_SAMPLE_FIRST_PROMPT = "Show me what a vibe-replay session looks like.";

const __dirname = dirname(fileURLToPath(import.meta.url));

function bundledSampleCandidates(): string[] {
  return [
    join(__dirname, "..", "assets", "samples", "welcome.jsonl"),
    join(__dirname, "assets", "samples", "welcome.jsonl"),
    join(__dirname, "..", "..", "assets", "samples", "welcome.jsonl"),
  ];
}

export async function resolveBundledSamplePath(): Promise<string | null> {
  for (const candidate of bundledSampleCandidates()) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
    }
  }
  return null;
}

export async function loadBundledSampleSession(): Promise<SessionInfo | null> {
  const filePath = await resolveBundledSamplePath();
  if (!filePath) return null;
  const info = await stat(filePath);
  const text = await readFile(filePath, "utf-8");
  const lineCount = text.split("\n").filter((line) => line.trim().length > 0).length;
  return {
    provider: "claude-code",
    sessionId: BUNDLED_SAMPLE_SESSION_ID,
    slug: BUNDLED_SAMPLE_SLUG,
    title: "Sample: Welcome to vibe-replay",
    project: "vibe-replay sample",
    cwd: "/sample/vibe-replay",
    version: "1.0.0",
    timestamp: BUNDLED_SAMPLE_TIMESTAMP,
    lineCount,
    fileSize: info.size,
    filePath,
    filePaths: [filePath],
    firstPrompt: BUNDLED_SAMPLE_FIRST_PROMPT,
    prompts: [BUNDLED_SAMPLE_FIRST_PROMPT],
    promptCount: 1,
    toolCallCount: 2,
    model: "claude-sonnet-4-20250514",
    durationMsEst: 4000,
    editCountEst: 1,
  };
}

export function isBundledSampleSession(session: Pick<SessionInfo, "sessionId">): boolean {
  return session.sessionId === BUNDLED_SAMPLE_SESSION_ID;
}

/** Empty-machine fallback so the picker and dashboard are not a blank wall. */
export async function withBundledSampleIfEmpty(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  if (sessions.length > 0) return sessions;
  const sample = await loadBundledSampleSession();
  return sample ? [sample] : sessions;
}
