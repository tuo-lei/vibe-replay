import { claudeCodeProvider } from "@vibe-replay/provider-claude-code/claude-code";
import { claudeCoworkProvider } from "@vibe-replay/provider-claude-code/claude-cowork";
import { claudeDesktopProvider } from "@vibe-replay/provider-claude-code/claude-desktop";
import { codexProvider } from "@vibe-replay/provider-codex";
import { cursorProvider } from "@vibe-replay/provider-cursor";
import { piProvider } from "@vibe-replay/provider-pi";
import type { Provider } from "@vibe-replay/provider-contract";
import type { SessionInfo } from "@vibe-replay/provider-contract";

const providers: Provider[] = [
  claudeCoworkProvider,
  claudeDesktopProvider,
  claudeCodeProvider,
  codexProvider,
  cursorProvider,
  piProvider,
];

// Priority order for deduplication — lower index = higher priority.
// Cowork ranks first because its audit.jsonl is self-contained and the only
// source of truth for agent-mode sessions (no other provider can discover them).
// Codex uses distinct rollout UUIDs, so it does not collide with the Claude family.
const PROVIDER_PRIORITY = [
  "claude-cowork",
  "claude-desktop",
  "claude-code",
  "codex",
  "cursor",
  "pi",
];

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
