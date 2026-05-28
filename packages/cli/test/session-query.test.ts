import { describe, expect, it } from "vitest";
import {
  filterSessionInfos,
  formatSessionQueryText,
  queryLocalSessions,
  scanInputFromSession,
} from "../src/session-query.js";
import type { SessionInfo } from "../src/types.js";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    provider: "cursor",
    sessionId: "session-1",
    slug: "fix-login",
    title: "Fix login regression",
    project: "/Users/test/Code/app",
    cwd: "/Users/test/Code/app",
    version: "1.0.0",
    gitBranch: "main",
    timestamp: "2026-05-01T10:00:00Z",
    lineCount: 10,
    fileSize: 1000,
    filePath: "/tmp/session.jsonl",
    filePaths: ["/tmp/session.jsonl"],
    firstPrompt: "Please fix the login bug",
    prompts: ["Please fix the login bug", "Run the tests"],
    ...overrides,
  };
}

describe("session query", () => {
  const sessions = [
    session({
      sessionId: "older",
      slug: "add-dashboard",
      title: "Add dashboard filters",
      project: "/Users/test/Code/vibe-replay",
      timestamp: "2026-05-01T10:00:00Z",
      firstPrompt: "Build project analytics filters",
    }),
    session({
      sessionId: "newer",
      slug: "codex-parser",
      provider: "codex",
      title: "Improve Codex replay parity",
      project: "/Users/test/Code/vibe-replay",
      gitBranch: "codex-replay-parity",
      model: "gpt-5.4",
      timestamp: "2026-05-02T10:00:00Z",
      firstPrompt: "Handle Codex compaction and patch events",
      fsDetectedFiles: ["packages/cli/src/providers/codex/parser.ts"],
    }),
    session({
      sessionId: "other-project",
      slug: "auth-flow",
      title: "Fix auth flow",
      project: "/Users/test/Code/api",
      timestamp: "2026-05-03T10:00:00Z",
      firstPrompt: "Debug login callback failures",
    }),
  ];

  it("filters sessions by query terms across metadata", () => {
    const result = filterSessionInfos(sessions, { query: "codex parser" });

    expect(result.map((s) => s.sessionId)).toEqual(["newer"]);
  });

  it("filters by project and provider, sorted newest first", () => {
    const result = filterSessionInfos(sessions, {
      project: "vibe-replay",
      provider: "cursor",
    });

    expect(result.map((s) => s.sessionId)).toEqual(["older"]);
  });

  it("limits query results and formats text output", async () => {
    const result = await queryLocalSessions(sessions, { query: "login", limit: 1 });
    const text = formatSessionQueryText(result);

    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("other-project");
    expect(text).toContain("Fix auth flow");
    expect(text).toContain("first prompt: Debug login callback failures");
  });

  it("maps discovery sessions into scanner input", () => {
    const input = scanInputFromSession(
      session({
        hasSqlite: true,
        workspacePath: "/Users/test/Code/app",
        toolPaths: ["/tmp/tool.txt"],
      }),
    );

    expect(input).toMatchObject({
      sessionId: "session-1",
      provider: "cursor",
      slug: "fix-login",
      filePaths: ["/tmp/session.jsonl"],
      toolPaths: ["/tmp/tool.txt"],
      sourceFilePath: "/tmp/session.jsonl",
      hasSqlite: true,
      workspacePath: "/Users/test/Code/app",
    });
  });
});
