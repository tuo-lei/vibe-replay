import { describe, expect, it } from "vitest";
import { mergeSameSessions } from "../src/session-merge.js";
import type { SessionInfo } from "../src/types.js";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "claude-code",
    sessionId: "session-1",
    slug: "shared-slug",
    project: "/project",
    cwd: "/project",
    version: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 10,
    fileSize: 100,
    filePath: "/sessions/one.jsonl",
    filePaths: ["/sessions/one.jsonl"],
    firstPrompt: "First prompt",
    ...overrides,
  };
}

describe("mergeSameSessions", () => {
  it("merges chronological Claude resume shards and deduplicates paths", () => {
    const merged = mergeSameSessions([
      session({ promptCount: 1, toolCallCount: 2 }),
      session({
        sessionId: "session-2",
        timestamp: "2026-01-01T01:00:00.000Z",
        filePath: "/sessions/two.jsonl",
        filePaths: ["/sessions/one.jsonl", "/sessions/two.jsonl"],
        lineCount: 20,
        fileSize: 200,
        promptCount: 3,
        toolCallCount: 4,
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sessionId: "session-2",
      lineCount: 30,
      fileSize: 300,
      promptCount: 4,
      toolCallCount: 6,
      filePaths: ["/sessions/one.jsonl", "/sessions/two.jsonl"],
    });
  });

  it("does not merge independent non-resumable sessions with the same slug and project", () => {
    const merged = mergeSameSessions([
      session({ provider: "opencode", sessionId: "ses_one" }),
      session({
        provider: "opencode",
        sessionId: "ses_two",
        filePath: "/db#session:ses_two",
        filePaths: ["/db#session:ses_two"],
      }),
    ]);

    expect(merged.map((item) => item.sessionId).sort()).toEqual(["ses_one", "ses_two"]);
  });

  it("does not merge sessions across providers even when their native identity matches", () => {
    const merged = mergeSameSessions([
      session({ provider: "claude-code" }),
      session({ provider: "pi" }),
    ]);

    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((item) => item.provider))).toEqual(new Set(["claude-code", "pi"]));
  });

  it("keeps newest sessions first", () => {
    const merged = mergeSameSessions([
      session({ provider: "pi", sessionId: "old" }),
      session({
        provider: "pi",
        sessionId: "new",
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(merged.map((item) => item.sessionId)).toEqual(["new", "old"]);
  });
});
