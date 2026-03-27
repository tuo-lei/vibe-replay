import { describe, expect, it } from "vitest";
import { checkCleanupWarnings, computeDaysUntilCleanup } from "../src/cleanup-warning.js";
import type { SessionInfo } from "../src/types.js";

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    provider: "claude-code",
    sessionId: "test-session-id",
    slug: "test-slug",
    project: "~/Code/test",
    cwd: "/Users/test/Code/test",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    lineCount: 100,
    fileSize: 1024,
    filePath: "/path/to/session.jsonl",
    filePaths: ["/path/to/session.jsonl"],
    firstPrompt: "test prompt",
    ...overrides,
  };
}

describe("computeDaysUntilCleanup", () => {
  it("returns null when cleanupPeriodDays is 0 (disabled)", () => {
    expect(computeDaysUntilCleanup(new Date().toISOString(), 0)).toBeNull();
  });

  it("returns null for invalid timestamp", () => {
    expect(computeDaysUntilCleanup("invalid-date", 30)).toBeNull();
  });

  it("returns correct days for a recent session", () => {
    // Session created 5 days ago with 30-day cleanup → ~25 days left
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const daysLeft = computeDaysUntilCleanup(fiveDaysAgo, 30);
    expect(daysLeft).toBe(25);
  });

  it("returns 0 for sessions past cleanup deadline", () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const daysLeft = computeDaysUntilCleanup(fortyDaysAgo, 30);
    expect(daysLeft).toBe(0);
  });

  it("returns correct days for session near expiry", () => {
    // Session created 27 days ago with 30-day cleanup → 3 days left
    const twentySevenDaysAgo = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString();
    const daysLeft = computeDaysUntilCleanup(twentySevenDaysAgo, 30);
    expect(daysLeft).toBe(3);
  });
});

describe("checkCleanupWarnings", () => {
  it("returns null when no sessions are expiring", () => {
    const sessions = [
      makeSession({ timestamp: new Date().toISOString() }),
      makeSession({ timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    expect(checkCleanupWarnings(sessions, 30)).toBeNull();
  });

  it("returns null when cleanupPeriodDays is 0", () => {
    const sessions = [
      makeSession({ timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    expect(checkCleanupWarnings(sessions, 0)).toBeNull();
  });

  it("detects sessions within warning threshold", () => {
    const sessions = [
      // 25 days old → 5 days left → within 7-day threshold
      makeSession({
        timestamp: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
        filePath: "/path/expiring.jsonl",
      }),
      // 10 days old → 20 days left → safe
      makeSession({
        timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        filePath: "/path/safe.jsonl",
      }),
    ];
    const result = checkCleanupWarnings(sessions, 30);
    expect(result).not.toBeNull();
    expect(result!.expiringCount).toBe(1);
    expect(result!.soonestDays).toBe(5);
    expect(result!.cleanupPeriodDays).toBe(30);
  });

  it("ignores non-claude-code sessions", () => {
    const sessions = [
      makeSession({
        provider: "cursor",
        timestamp: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    expect(checkCleanupWarnings(sessions, 30)).toBeNull();
  });

  it("reports the soonest expiry correctly", () => {
    const sessions = [
      makeSession({
        timestamp: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
        filePath: "/path/a.jsonl",
      }),
      makeSession({
        timestamp: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
        filePath: "/path/b.jsonl",
      }),
      makeSession({
        timestamp: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
        filePath: "/path/c.jsonl",
      }),
    ];
    const result = checkCleanupWarnings(sessions, 30);
    expect(result).not.toBeNull();
    expect(result!.expiringCount).toBe(3);
    expect(result!.soonestDays).toBe(1);
  });

  it("supports custom warning threshold", () => {
    const sessions = [
      // 25 days old → 5 days left → outside 3-day threshold
      makeSession({
        timestamp: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    expect(checkCleanupWarnings(sessions, 30, 3)).toBeNull();

    // 28 days old → 2 days left → within 3-day threshold
    const urgentSessions = [
      makeSession({
        timestamp: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const result = checkCleanupWarnings(urgentSessions, 30, 3);
    expect(result).not.toBeNull();
    expect(result!.expiringCount).toBe(1);
  });
});
