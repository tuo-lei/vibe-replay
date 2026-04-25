/**
 * Helpers for surfacing session importance and provenance in visualizations.
 * Used by SessionRelationshipsView to make significant work pop and to
 * separate user-driven sessions from automated/scheduled noise.
 */

import type { SessionScanWireData } from "@vibe-replay/types";

/**
 * Importance score in [0, 100]. Combines durable signals (PR links, edits,
 * sub-agents) with usage signals (turns, tool calls). Penalises automated runs.
 *
 * The exact constants are tuned by inspection — bump factors for signals you
 * want to surface more.
 */
export function sessionScore(s: SessionScanWireData): number {
  const turns = Math.log2(s.promptCount + 1);
  const tools = Math.log2(s.toolCallCount + 1) * 0.4;
  const edits = Math.min(8, Math.log2(s.editCount + 1));
  const files = Math.min(4, Math.log2((s.filesModified?.length ?? 0) + 1));
  const subAgents = s.subAgentCount > 0 ? 3 : 0;
  const hasPR = (s.prLinks?.length ?? 0) > 0 ? 8 : 0;
  const longRun = s.durationMs && s.durationMs > 30 * 60 * 1000 ? 4 : 0;
  const automatedPenalty = isAutomated(s) ? -10 : 0;

  const raw = turns + tools + edits + files + subAgents + hasPR + longRun + automatedPenalty;
  // Map roughly into 0-100 range; clamp.
  return Math.max(0, Math.min(100, raw * 4));
}

/**
 * A session is "automated" when it was kicked off by a scheduler / background
 * job rather than by an interactive prompt. Three signals catch ~all of them:
 *   - Cowork "scheduled task" preamble in the first prompt
 *   - Claude Desktop entrypoint (Cowork orchestrator)
 *   - claude-cowork provider with a scheduled-style preamble
 */
export function isAutomated(s: SessionScanWireData): boolean {
  const first = s.firstPrompt ?? "";
  if (/^This is an automated run of a scheduled task/i.test(first)) return true;
  if (s.entrypoint === "claude-desktop" && /scheduled|automated/i.test(first.slice(0, 200))) {
    return true;
  }
  return false;
}
