import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { hasReplayableContent, resolveGenerateInputs, safeTargetId } from "../src/server-core.js";
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

  it("falls back to matching by sessionId when the replay slug differs", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "oldslug0",
        sessionId: "cursor-session-from-db",
      },
      [
        makeSession({
          slug: "newslug0",
          sessionId: "cursor-session-from-db",
          filePaths: [],
          toolPaths: [],
        }),
      ],
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.paths).toEqual([]);
    expect(resolved.value.sessionInfo?.slug).toBe("newslug0");
  });

  it("does not resolve a slug or session ID from a different provider", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: [],
        sessionSlug: "shared01",
        sessionId: "shared-id",
      },
      [
        makeSession({
          provider: "claude-code",
          slug: "shared01",
          sessionId: "shared-id",
          filePaths: ["/tmp/claude.jsonl"],
          toolPaths: [],
        }),
        makeSession({
          provider: "cursor",
          slug: "cursor01",
          sessionId: "cursor-id",
          filePaths: [],
          toolPaths: [],
        }),
      ],
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("filePaths is required");
  });

  it("uses explicit tool paths instead of discovered tool paths", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "cursor",
        filePaths: ["/explicit/session.jsonl"],
        toolPaths: ["/explicit/tool.txt"],
        sessionSlug: "aaaaaaaa",
      },
      [makeSession()],
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.paths).toEqual(["/explicit/session.jsonl", "/explicit/tool.txt"]);
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

  it("matches the requested local or SSH location when slugs collide", () => {
    const local = makeSession({
      provider: "codex",
      sessionId: "shared-session",
      slug: "shared-slug",
      filePaths: ["/local/session.jsonl"],
      toolPaths: [],
    });
    const remote = makeSession({
      provider: "codex",
      sessionId: "shared-session",
      slug: "shared-slug",
      filePaths: ["/cache/remote/session.jsonl"],
      toolPaths: [],
      location: { kind: "ssh", id: "remote-a", label: "Remote A" },
    });

    const localResult = resolveGenerateInputs(
      { provider: "codex", filePaths: [], sessionSlug: "shared-slug" },
      [remote, local],
    );
    expect(localResult.ok && localResult.value.sessionInfo?.location).toBeUndefined();
    expect(localResult.ok && localResult.value.paths).toEqual(["/local/session.jsonl"]);

    const remoteResult = resolveGenerateInputs(
      {
        provider: "codex",
        filePaths: [],
        sessionSlug: "shared-slug",
        targetId: "remote-a",
      },
      [local, remote],
    );
    expect(remoteResult.ok && remoteResult.value.sessionInfo?.location).toEqual(remote.location);
    expect(remoteResult.ok && remoteResult.value.paths).toEqual(["/cache/remote/session.jsonl"]);
  });

  it.each(["no-prompts", "unreadable"] as const)(
    "rejects a %s transcript before attempting generation",
    (transcriptStatus) => {
      const resolved = resolveGenerateInputs(
        {
          provider: "codex",
          filePaths: [],
          sessionSlug: "metadata-only",
        },
        [
          makeSession({
            provider: "codex",
            sessionId: "metadata-only",
            slug: "metadata-only",
            filePaths: [],
            toolPaths: [],
            firstPrompt: "",
            transcriptStatus,
          }),
        ],
      );

      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.error).toBe(
        transcriptStatus === "no-prompts"
          ? "This session has no replayable user prompts"
          : "This session transcript is unavailable or unreadable",
      );
    },
  );

  it("does not allow explicit paths from another session for SSH generation", () => {
    const resolved = resolveGenerateInputs(
      {
        provider: "codex",
        filePaths: ["/local/session.jsonl"],
        sessionSlug: "shared-slug",
        targetId: "remote-a",
      },
      [
        makeSession({
          provider: "codex",
          sessionId: "remote-session",
          slug: "shared-slug",
          filePaths: ["/cache/remote/session.jsonl"],
          toolPaths: [],
          location: { kind: "ssh", id: "remote-a", label: "Remote A" },
        }),
      ],
    );

    expect(resolved).toEqual({
      ok: false,
      error: "Requested paths do not belong to the selected SSH source session",
    });
  });
});

describe("safeTargetId", () => {
  it("distinguishes omitted targets from invalid and valid source ids", () => {
    expect(safeTargetId(undefined)).toBeUndefined();
    expect(safeTargetId("")).toBeUndefined();
    expect(safeTargetId(" remote-dev ")).toBe("remote-dev");
    expect(safeTargetId("remote/dev")).toBeNull();
    expect(safeTargetId("-oProxyCommand=bad")).toBeNull();
  });

  it("reserves the local namespace", () => {
    expect(safeTargetId("local")).toBeNull();
  });
});

describe("hasReplayableContent", () => {
  const meta = {
    sessionId: "session",
    slug: "session",
    provider: "codex",
    startTime: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    project: "/tmp/project",
    stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 },
  };

  it("requires a real user-prompt scene", () => {
    expect(hasReplayableContent({ meta, scenes: [] })).toBe(false);
    expect(
      hasReplayableContent({
        meta,
        scenes: [{ type: "context-injection", content: "metadata", injectionType: "other" }],
      }),
    ).toBe(false);
    expect(
      hasReplayableContent({
        meta,
        scenes: [{ type: "user-prompt", content: "Please inspect the project" }],
      }),
    ).toBe(true);
  });
});
