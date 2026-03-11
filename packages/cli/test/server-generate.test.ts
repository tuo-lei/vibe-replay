import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveGenerateInputs } from "../src/server.js";
import type { SessionInfo } from "../src/types.js";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "cursor",
    sessionId: "cursor-session-a",
    slug: "aaaaaaaa",
    project: "~/project-a",
    cwd: "/tmp/project-a",
    version: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 10,
    fileSize: 1024,
    filePath: "/tmp/session.jsonl",
    filePaths: ["/tmp/session.jsonl"],
    toolPaths: ["/tmp/tool.txt"],
    firstPrompt: "test prompt",
    ...overrides,
  };
}

describe("resolveGenerateInputs", () => {
  it("rejects non-array filePaths payload", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: "not-an-array",
      },
      [],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toBe("filePaths must be an array of strings");
  });

  it("rejects filePaths arrays with non-string entries", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: ["/tmp/session.jsonl", 42],
      },
      [],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toBe("filePaths must be an array of strings");
  });

  it("rejects non-array toolPaths payload", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: ["/tmp/session.jsonl"],
        toolPaths: "not-an-array",
      },
      [],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toBe("toolPaths must be an array of strings");
  });

  it("uses explicit file paths and falls back to discovered tool paths", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: ["/explicit/session.jsonl"],
        sessionSlug: "aaaaaaaa",
      },
      [makeSession()],
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.paths).toEqual(["/explicit/session.jsonl", "/tmp/tool.txt"]);
    expect(resolved.value.sessionInfo?.slug).toBe("aaaaaaaa");
  });

  it("allows Cursor sqlite/global-state session with empty file paths", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "6d8dd9bc",
      },
      [
        makeSession({
          slug: "6d8dd9bc",
          sessionId: "cursor-session-devspaces",
          filePaths: [],
          toolPaths: [],
        }),
      ],
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.paths).toHaveLength(0);
    expect(resolved.value.sessionInfo?.sessionId).toBe("cursor-session-devspaces");
  });

  it("matches session by normalized project path when slug collides", () => {
    const home = homedir();
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "aaaaaaaa",
        sessionProject: `${home}/project-b`,
      },
      [
        makeSession({
          project: "~/project-a",
          sessionId: "cursor-session-a",
          filePaths: [],
          toolPaths: [],
        }),
        makeSession({
          project: "~/project-b",
          sessionId: "cursor-session-b",
          filePaths: [],
          toolPaths: [],
        }),
      ],
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.sessionInfo?.project).toBe("~/project-b");
    expect(resolved.value.sessionInfo?.sessionId).toBe("cursor-session-b");
  });

  it("still requires file paths for non-cursor providers", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "claude-code",
        filePaths: [],
        sessionSlug: "aaaaaaaa",
      },
      [makeSession({ provider: "claude-code", filePaths: [], toolPaths: [] })],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("filePaths is required");
  });

  it("rejects empty Cursor paths when session slug is unsafe", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "../../../etc/passwd",
      },
      [makeSession({ filePaths: [], toolPaths: [] })],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("filePaths is required");
  });

  it("rejects empty Cursor paths when session slug does not resolve", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "missing01",
      },
      [makeSession({ slug: "different", filePaths: [], toolPaths: [] })],
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("filePaths is required");
  });
});
