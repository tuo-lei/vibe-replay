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

  it("can broaden multi-term queries with any-term matching", () => {
    expect(filterSessionInfos(sessions, { query: "codex auth" })).toHaveLength(0);

    const result = filterSessionInfos(sessions, { query: "codex auth", any: true });

    expect(result.map((s) => s.sessionId)).toEqual(["other-project", "newer"]);
  });

  it("does not match short acronym terms inside longer words", () => {
    const result = filterSessionInfos(
      [
        session({
          sessionId: "pricing",
          slug: "pricing",
          title: "Cursor model pricing",
          firstPrompt: "Update model prices",
        }),
        session({
          sessionId: "pr-review",
          slug: "pr-review",
          title: "PR review CI followup",
          firstPrompt: "Review the PR and CI checks",
        }),
      ],
      { query: "PR CI", any: true },
    );

    expect(result.map((s) => s.sessionId)).toEqual(["pr-review"]);
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

  it("adds scored match context and scan-backed briefs", async () => {
    const result = await queryLocalSessions(sessions, {
      query: "codex auth",
      any: true,
      brief: true,
      limit: 2,
    });

    expect(result.map((s) => s.sessionId)).toEqual(["other-project", "newer"]);
    expect(result[0]?.matchedTerms).toEqual(["auth"]);
    expect(result[0]?.unmatchedTerms).toEqual(["codex"]);
    expect(result[0]?.matchQuality).toBe("weak");
    expect(result[0]?.whyMatched?.[0]).toContain("auth in title");
    expect(result[0]?.brief?.taskType).toBe("auth/debugging");
    expect(result[0]?.brief?.suggestedNextAction).toContain("filePaths");
  });

  it("keeps weak broad matches but makes match quality explicit", async () => {
    const result = await queryLocalSessions(
      [
        session({
          sessionId: "one-term",
          title: "Toast fix",
          firstPrompt: "Make the toast nicer",
        }),
        session({
          sessionId: "two-terms",
          title: "Toast style loading polish",
          firstPrompt: "Improve loading toast style",
        }),
      ],
      { query: "toast style loading metrics", any: true, brief: true },
    );

    expect(result.map((s) => s.sessionId)).toEqual(["two-terms", "one-term"]);
    expect(result[0]?.matchQuality).toBe("strong");
    expect(result[0]?.matchedTerms).toEqual(["toast", "style", "loading"]);
    expect(result[0]?.unmatchedTerms).toEqual(["metrics"]);
    expect(result[1]?.matchQuality).toBe("weak");
    expect(result[1]?.matchedTerms).toEqual(["toast"]);
    expect(result[1]?.unmatchedTerms).toEqual(["style", "loading", "metrics"]);
  });

  it("keeps explicit any-term matching broad", () => {
    const result = filterSessionInfos(
      [
        session({
          sessionId: "one-term",
          title: "Toast style fix",
          firstPrompt: "Make the toast nicer",
        }),
      ],
      { query: "toast unknown metrics", any: true },
    );

    expect(result.map((s) => s.sessionId)).toEqual(["one-term"]);
  });

  it("deduplicates repeated long-prompt sessions when requested", () => {
    const repeatedPrompt =
      "https://github.rbx.com/Roblox/skills/pull/162 canonical skill migration decision and sync strategy";
    const result = filterSessionInfos(
      [
        session({
          sessionId: "newer-copy",
          title: repeatedPrompt,
          firstPrompt: repeatedPrompt,
          timestamp: "2026-05-04T10:00:00Z",
        }),
        session({
          sessionId: "older-copy",
          title: repeatedPrompt,
          firstPrompt: repeatedPrompt,
          project: "/Users/test/Code/other-workspace",
          timestamp: "2026-05-03T10:00:00Z",
        }),
      ],
      { query: "canonical skill", dedupe: true },
    );

    expect(result.map((s) => s.sessionId)).toEqual(["newer-copy"]);
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
