import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "./types.js";

const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
const WARNING_THRESHOLD_DAYS = 7;

export interface CleanupWarningResult {
  expiringCount: number;
  soonestDays: number;
  cleanupPeriodDays: number;
}

/**
 * Read Claude Code's cleanupPeriodDays setting.
 * Checks settings.local.json first (user override), then settings.json.
 * Returns 0 if cleanup is disabled, or the configured/default period in days.
 */
export async function getClaudeCodeCleanupPeriod(): Promise<number> {
  const home = homedir();
  for (const file of [
    join(home, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
  ]) {
    try {
      const raw = await readFile(file, "utf-8");
      const settings = JSON.parse(raw);
      if (typeof settings.cleanupPeriodDays === "number") {
        return settings.cleanupPeriodDays;
      }
    } catch {
      // file doesn't exist or invalid JSON — try next
    }
  }
  return DEFAULT_CLEANUP_PERIOD_DAYS;
}

/**
 * Compute days until a session is cleaned up by Claude Code.
 * Returns null if the session is not a claude-code session or cleanup is disabled.
 */
export function computeDaysUntilCleanup(
  timestamp: string,
  cleanupPeriodDays: number,
): number | null {
  if (cleanupPeriodDays <= 0) return null;
  const sessionTime = new Date(timestamp).getTime();
  if (Number.isNaN(sessionTime)) return null;
  const ageDays = (Date.now() - sessionTime) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(cleanupPeriodDays - ageDays));
}

/**
 * Check which Claude Code sessions are approaching cleanup.
 * Returns null if no sessions are within the warning threshold.
 */
export function checkCleanupWarnings(
  sessions: SessionInfo[],
  cleanupPeriodDays: number,
  warningThresholdDays = WARNING_THRESHOLD_DAYS,
): CleanupWarningResult | null {
  if (cleanupPeriodDays <= 0) return null;

  let soonestDays = Number.POSITIVE_INFINITY;
  let expiringCount = 0;

  for (const session of sessions) {
    if (session.provider !== "claude-code") continue;
    const daysLeft = computeDaysUntilCleanup(session.timestamp, cleanupPeriodDays);
    if (daysLeft != null && daysLeft <= warningThresholdDays) {
      expiringCount++;
      if (daysLeft < soonestDays) soonestDays = daysLeft;
    }
  }

  if (expiringCount === 0) return null;
  return { expiringCount, soonestDays, cleanupPeriodDays };
}
