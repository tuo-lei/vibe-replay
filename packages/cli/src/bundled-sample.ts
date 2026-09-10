import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "@vibe-replay/provider-contract";

export const BUNDLED_SAMPLE_SESSION_ID = "vibe-replay-sample-welcome";
export const BUNDLED_GROK_BOT_SAMPLE_SESSION_ID = "vibe-replay-sample-grok-bot";
const BUNDLED_SAMPLE_SLUG = "welcome-sample";
const BUNDLED_GROK_BOT_SAMPLE_SLUG = "grok-bot-sample";
const BUNDLED_SAMPLE_TIMESTAMP = "2026-09-01T12:00:05.000Z";
const BUNDLED_GROK_BOT_SAMPLE_TIMESTAMP = "2026-09-01T12:00:10.000Z";
const BUNDLED_SAMPLE_FIRST_PROMPT = "Show me what a vibe-replay session looks like.";
const BUNDLED_GROK_BOT_SAMPLE_FIRST_PROMPT = "Show me what a Grok Bot replay looks like.";

const __dirname = dirname(fileURLToPath(import.meta.url));

function bundledSampleCandidates(filename: string): string[] {
  return [
    join(__dirname, "..", "assets", "samples", filename),
    join(__dirname, "assets", "samples", filename),
    join(__dirname, "..", "..", "assets", "samples", filename),
  ];
}

async function resolveBundledAsset(filename: string): Promise<string | null> {
  for (const candidate of bundledSampleCandidates(filename)) {
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

export async function resolveBundledSamplePath(): Promise<string | null> {
  return resolveBundledAsset("welcome.jsonl");
}

export async function resolveBundledGrokBotSamplePath(): Promise<string | null> {
  return resolveBundledAsset("grok-bot.jsonl");
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

export async function loadBundledGrokBotSampleSession(): Promise<SessionInfo | null> {
  const filePath = await resolveBundledGrokBotSamplePath();
  if (!filePath) return null;
  const info = await stat(filePath);
  const text = await readFile(filePath, "utf-8");
  const lineCount = text.split("\n").filter((line) => line.trim().length > 0).length;
  return {
    provider: "grok-bot",
    sessionId: BUNDLED_GROK_BOT_SAMPLE_SESSION_ID,
    slug: BUNDLED_GROK_BOT_SAMPLE_SLUG,
    title: "Sample: Grok Bot Eng+GTM",
    project: "vibe-replay sample",
    cwd: "/sample/vibe-replay",
    version: "1",
    timestamp: BUNDLED_GROK_BOT_SAMPLE_TIMESTAMP,
    lineCount,
    fileSize: info.size,
    filePath,
    filePaths: [filePath],
    firstPrompt: BUNDLED_GROK_BOT_SAMPLE_FIRST_PROMPT,
    prompts: [BUNDLED_GROK_BOT_SAMPLE_FIRST_PROMPT],
    promptCount: 1,
    toolCallCount: 2,
    durationMsEst: 4000,
  };
}

export function isBundledSampleSession(session: Pick<SessionInfo, "sessionId">): boolean {
  return (
    session.sessionId === BUNDLED_SAMPLE_SESSION_ID ||
    session.sessionId === BUNDLED_GROK_BOT_SAMPLE_SESSION_ID
  );
}

function hasGrokBotSession(sessions: SessionInfo[]): boolean {
  return sessions.some((session) => session.provider === "grok-bot");
}

/**
 * Empty-machine fallback so the picker and dashboard are not a blank wall.
 * Grok Bot sample is also injected when discovery found no grok sessions
 * (typical laptop/Mac: Claude/Cursor may exist, box transcript roots do not).
 */
export async function withBundledSampleIfEmpty(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  const result = sessions.length > 0 ? [...sessions] : [];
  if (result.length === 0) {
    const sample = await loadBundledSampleSession();
    if (sample) result.push(sample);
  }
  if (!hasGrokBotSession(result)) {
    const grokSample = await loadBundledGrokBotSampleSession();
    if (grokSample) result.push(grokSample);
  }
  return result;
}
