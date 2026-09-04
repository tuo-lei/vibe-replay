import { homedir } from "node:os";
import { join } from "node:path";

/** Cloud-box transcript dirs. `agent-data` often symlinks to `sand-data`. */
export const DEFAULT_GROK_BOT_BOX_ROOTS = [
  "/home/box/agent-data/agent-transcripts",
  "/home/box/sand-data/agent-transcripts",
] as const;

/** Documented export path for users who copy transcripts off the box. */
export const DEFAULT_GROK_BOT_EXPORT_ROOT = join(homedir(), ".grok-bot", "agent-transcripts");

const ENV_TRANSCRIPTS_DIR = "GROK_BOT_TRANSCRIPTS_DIR";
const ENV_VIBE_DIR = "VIBE_REPLAY_GROK_BOT_DIR";

export function getGrokBotEnvTranscriptsDir(): string | undefined {
  const fromGrok = process.env[ENV_TRANSCRIPTS_DIR]?.trim();
  if (fromGrok) return fromGrok;
  const fromVibe = process.env[ENV_VIBE_DIR]?.trim();
  return fromVibe || undefined;
}

/**
 * Transcript roots to scan.
 *
 * `GROK_BOT_TRANSCRIPTS_DIR` (or `VIBE_REPLAY_GROK_BOT_DIR`) replaces the
 * defaults, matching Pi's `PI_CODING_AGENT_SESSION_DIR` override style.
 * When unset, scan the cloud-box locations plus the optional export path.
 */
export function getGrokBotTranscriptRoots(): string[] {
  const override = getGrokBotEnvTranscriptsDir();
  if (override) return [override];
  return [...DEFAULT_GROK_BOT_BOX_ROOTS, DEFAULT_GROK_BOT_EXPORT_ROOT];
}
