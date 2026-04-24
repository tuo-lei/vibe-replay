import { claudeCodeProvider } from "./claude-code/index.js";
import { claudeDesktopProvider } from "./claude-desktop/index.js";
import { cursorProvider } from "./cursor/index.js";
import type { Provider } from "./types.js";
import type { SessionInfo } from "../types.js";

const providers: Provider[] = [claudeDesktopProvider, claudeCodeProvider, cursorProvider];

// Priority order for deduplication — lower index = higher priority
const PROVIDER_PRIORITY = ["claude-desktop", "claude-code", "cursor"];

export function getAllProviders(): Provider[] {
  return providers;
}

export function getProvider(name: string): Provider | undefined {
  return providers.find((p) => p.name === name);
}

/**
 * Deduplicate sessions by sessionId, preferring claude-desktop > claude-code > cursor.
 * Desktop sessions share the same sessionId (cliSessionId) as their backing JSONL, so
 * without deduplication a session discovered by both claude-desktop and claude-code
 * would appear twice in the picker.
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
