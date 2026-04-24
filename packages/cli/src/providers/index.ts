import { claudeCodeProvider } from "./claude-code/index.js";
import { claudeCoworkProvider } from "./claude-cowork/index.js";
import { claudeDesktopProvider } from "./claude-desktop/index.js";
import { cursorProvider } from "./cursor/index.js";
import type { Provider } from "./types.js";
import type { SessionInfo } from "../types.js";

const providers: Provider[] = [
  claudeCoworkProvider,
  claudeDesktopProvider,
  claudeCodeProvider,
  cursorProvider,
];

// Priority order for deduplication — lower index = higher priority.
// Cowork ranks first because its audit.jsonl is self-contained and the only
// source of truth for agent-mode sessions (no other provider can discover them).
const PROVIDER_PRIORITY = ["claude-cowork", "claude-desktop", "claude-code", "cursor"];

export function getAllProviders(): Provider[] {
  return providers;
}

export function getProvider(name: string): Provider | undefined {
  return providers.find((p) => p.name === name);
}

/**
 * Deduplicate sessions by sessionId, preferring
 * claude-cowork > claude-desktop > claude-code > cursor.
 *
 * Each provider derives sessionId from a different source, so it's worth being
 * explicit about which IDs can actually collide:
 *   - claude-desktop uses metadata.cliSessionId, which is *the same UUID* as
 *     the backing ~/.claude/projects/ JSONL. So the same session shows up
 *     under both claude-desktop AND claude-code — dedup-by-sessionId collapses
 *     them and the priority ordering keeps the richer Desktop metadata.
 *   - claude-cowork uses metadata.sessionId (minus `local_`) — deliberately
 *     NOT cliSessionId. Cowork transcripts live in a separate directory and
 *     do not overlap with the other providers; ranking Cowork first here is
 *     purely defensive (and makes the contract explicit).
 *   - cursor uses its own IDs which never overlap with the Claude family.
 */
export function deduplicateSessionsByProvider(sessions: SessionInfo[]): SessionInfo[] {
  const seen = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const existing = seen.get(session.sessionId);
    if (!existing) {
      seen.set(session.sessionId, session);
    } else {
      const existingPrio = PROVIDER_PRIORITY.indexOf(existing.provider);
      const newPrio = PROVIDER_PRIORITY.indexOf(session.provider);
      if (newPrio !== -1 && (existingPrio === -1 || newPrio < existingPrio)) {
        seen.set(session.sessionId, session);
      }
    }
  }
  return Array.from(seen.values());
}
