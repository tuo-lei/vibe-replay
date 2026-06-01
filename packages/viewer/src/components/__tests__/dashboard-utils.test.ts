import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentWorktreeParent,
  cleanPrompt,
  dataSourceBadgeClass,
  fetchWithRetry,
  formatDataSourceLabel,
  getFriendlyErrorMessage,
  isCacheFresh,
  isNetworkError,
  nonDefaultBranch,
  parseCachedList,
  providerBadgeClass,
  providerBadgeLabel,
  providerBarClass,
  providerDisplayName,
  providerFamily,
  replaySuggestedTitle,
  rollupProject,
  rollupTopProjects,
  sessionPromptPreview,
  shortCoworkSpaceId,
  sourceDisplayTitle,
  sourceSuggestedTitle,
  type TopProjectEntry,
} from "../dashboard-utils";
import type { SourceSession } from "../../types";

function makeProject(overrides: Partial<TopProjectEntry> & { project: string }): TopProjectEntry {
  return {
    sessions: 0,
    cost: 0,
    prompts: 0,
    durationMs: 0,
    toolCalls: 0,
    edits: 0,
    branchCount: 0,
    prCount: 0,
    memoryFileCount: 0,
    lastActivity: "",
    sessionsPerDay: {},
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceSession> = {}): SourceSession {
  return {
    provider: "cursor",
    slug: "source-slug",
    project: "~/Code/app",
    timestamp: "2026-05-01T10:00:00.000Z",
    fileSize: 1024,
    lineCount: 10,
    firstPrompt: "Build the dashboard",
    filePaths: ["/tmp/session.jsonl"],
    existingReplay: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agentWorktreeParent", () => {
  it("returns the parent project for a Claude agent worktree path", () => {
    expect(
      agentWorktreeParent("~/Code/vibe-replay/.claude/worktrees/affectionate-darwin-968d37"),
    ).toBe("~/Code/vibe-replay");
    expect(
      agentWorktreeParent("/Users/tuo/Code/vibe-replay2/.claude/worktrees/xenodochial-swartz-20"),
    ).toBe("/Users/tuo/Code/vibe-replay2");
  });

  it("strips a trailing slash before matching", () => {
    expect(
      agentWorktreeParent("~/Code/vibe-replay/.claude/worktrees/affectionate-darwin-968d37/"),
    ).toBe("~/Code/vibe-replay");
  });

  it("matches paths nested inside a worktree (resolves to outermost parent)", () => {
    expect(
      agentWorktreeParent(
        "~/Code/vibe-replay/.claude/worktrees/affectionate-darwin-968d37/packages/cli",
      ),
    ).toBe("~/Code/vibe-replay");
  });

  it("returns null for non-worktree project paths", () => {
    expect(agentWorktreeParent("~/Code/vibe-replay")).toBeNull();
    expect(agentWorktreeParent("~/.claude")).toBeNull();
    expect(agentWorktreeParent("Cowork")).toBeNull();
    expect(agentWorktreeParent("")).toBeNull();
  });

  it("does not match when the worktree segment is missing a name", () => {
    expect(agentWorktreeParent("~/Code/vibe-replay/.claude/worktrees/")).toBeNull();
    expect(agentWorktreeParent("~/Code/vibe-replay/.claude/worktrees")).toBeNull();
  });

  it("does not match a path that merely contains the substring without the dot prefix", () => {
    // `claude/worktrees` (no leading dot) is not the convention Claude Code uses
    expect(agentWorktreeParent("~/Code/repo/claude/worktrees/foo")).toBeNull();
  });
});

describe("rollupProject", () => {
  it("rolls up worktree paths to the parent project", () => {
    expect(rollupProject("~/Code/vibe-replay/.claude/worktrees/affectionate-darwin-968d37")).toBe(
      "~/Code/vibe-replay",
    );
  });

  it("passes through non-worktree paths unchanged", () => {
    expect(rollupProject("~/Code/vibe-replay")).toBe("~/Code/vibe-replay");
    expect(rollupProject("__all__")).toBe("__all__");
    expect(rollupProject("")).toBe("");
  });
});

describe("rollupTopProjects", () => {
  it("merges worktree entries into the parent project", () => {
    const parent = makeProject({
      project: "~/Code/vibe-replay",
      sessions: 10,
      cost: 12.34,
      prompts: 100,
      durationMs: 60_000,
      toolCalls: 50,
      edits: 30,
      branchCount: 5,
      prCount: 2,
      memoryFileCount: 3,
      lastActivity: "2026-04-01T00:00:00Z",
      sessionsPerDay: { "2026-04-01": 2, "2026-04-02": 3 },
    });
    const worktreeA = makeProject({
      project: "~/Code/vibe-replay/.claude/worktrees/affectionate-darwin",
      sessions: 1,
      cost: 0.5,
      prompts: 4,
      durationMs: 5_000,
      toolCalls: 7,
      edits: 1,
      branchCount: 1,
      prCount: 1,
      memoryFileCount: 0,
      lastActivity: "2026-04-10T00:00:00Z",
      sessionsPerDay: { "2026-04-02": 1, "2026-04-10": 1 },
    });
    const worktreeB = makeProject({
      project: "~/Code/vibe-replay/.claude/worktrees/gallant-moser",
      sessions: 1,
      cost: 0.25,
      prompts: 2,
      toolCalls: 3,
      edits: 2,
      branchCount: 1,
      prCount: 0,
      sessionsPerDay: { "2026-04-09": 1 },
      lastActivity: "2026-04-09T00:00:00Z",
    });

    const result = rollupTopProjects([parent, worktreeA, worktreeB]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      project: "~/Code/vibe-replay",
      sessions: 12,
      prompts: 106,
      durationMs: 65_000,
      toolCalls: 60,
      edits: 33,
      branchCount: 7,
      prCount: 3,
      memoryFileCount: 3,
      lastActivity: "2026-04-10T00:00:00Z",
    });
    expect(result[0].cost).toBeCloseTo(13.09, 5);
    expect(result[0].sessionsPerDay).toEqual({
      "2026-04-01": 2,
      "2026-04-02": 4,
      "2026-04-09": 1,
      "2026-04-10": 1,
    });
  });

  it("rolls up worktrees even when the parent has no scan entry", () => {
    const result = rollupTopProjects([
      makeProject({
        project: "~/Code/vibe-replay/.claude/worktrees/lone",
        sessions: 1,
        prompts: 3,
        sessionsPerDay: { "2026-04-01": 1 },
        lastActivity: "2026-04-01T00:00:00Z",
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("~/Code/vibe-replay");
    expect(result[0].sessions).toBe(1);
  });

  it("leaves non-worktree projects untouched", () => {
    const result = rollupTopProjects([
      makeProject({ project: "~/Code/foo", sessions: 5 }),
      makeProject({ project: "~/Code/bar", sessions: 3 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.project).sort()).toEqual(["~/Code/bar", "~/Code/foo"]);
  });

  it("does not mutate the input entries", () => {
    const parent = makeProject({
      project: "~/Code/vibe-replay",
      sessions: 1,
      sessionsPerDay: { "2026-04-01": 1 },
    });
    const worktree = makeProject({
      project: "~/Code/vibe-replay/.claude/worktrees/x",
      sessions: 2,
      sessionsPerDay: { "2026-04-02": 2 },
    });
    rollupTopProjects([parent, worktree]);
    expect(parent.sessions).toBe(1);
    expect(parent.sessionsPerDay).toEqual({ "2026-04-01": 1 });
  });
});

describe("cache response helpers", () => {
  it("accepts cached list payloads and normalizes missing cachedAt", () => {
    expect(parseCachedList<{ slug: string }>({ sessions: [{ slug: "a" }] })).toEqual({
      sessions: [{ slug: "a" }],
      cachedAt: undefined,
    });
    expect(parseCachedList({ sessions: [], cachedAt: "2026-05-01T00:00:00.000Z" })).toEqual({
      sessions: [],
      cachedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("rejects malformed cached list payloads", () => {
    expect(parseCachedList(null)).toBeNull();
    expect(parseCachedList({ sessions: "not-array" })).toBeNull();
  });

  it("treats only recent past timestamps as fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));

    expect(isCacheFresh("2026-05-01T09:56:00.000Z")).toBe(true);
    expect(isCacheFresh("2026-05-01T09:54:59.000Z")).toBe(false);
    expect(isCacheFresh("2026-05-01T10:01:00.000Z")).toBe(false);
    expect(isCacheFresh("not-a-date")).toBe(false);
  });
});

describe("dashboard prompt and title helpers", () => {
  it("cleans noisy prompt text before display", () => {
    expect(cleanPrompt("<command-name>status</command-name>")).toBe("");
    expect(cleanPrompt("1|Please refactor\n2|the dashboard")).toBe("Please refactor the dashboard");
    expect(cleanPrompt("### AI Coding Session\n3 prompts, 4 tools, 10m\nShip it")).toBe("Ship it");
  });

  it("deduplicates prompt previews and hides a title duplicate", () => {
    const prompts = sessionPromptPreview(
      makeSource({
        firstPrompt: "Build the dashboard",
        prompts: ["Build the dashboard", "Then add tests", "Then add tests"],
      }),
      { firstPrompt: "Build the dashboard" },
      "Build the dashboard",
    );

    expect(prompts).toEqual(["Then add tests"]);
  });

  it("falls back through source and replay titles predictably", () => {
    const source = makeSource({
      title: "<task-notification>hidden</task-notification>",
      firstPrompt: "Implement search",
      replay: {
        slug: "source-slug",
        title: "Replay title",
        provider: "cursor",
        project: "~/Code/app",
        startTime: "2026-05-01T10:00:00.000Z",
        endTime: "2026-05-01T10:10:00.000Z",
        stats: { userPrompts: 1, toolCalls: 2 },
        hasAnnotations: false,
        annotationCount: 0,
        messages: [],
      },
    });

    expect(sourceSuggestedTitle(source)).toBe("Replay title");
    expect(sourceDisplayTitle(source, { title: "Scan title" })).toBe("Scan title");
    expect(replaySuggestedTitle({ ...source.replay!, firstMessage: "First replay prompt" })).toBe(
      "Replay title",
    );
  });
});

describe("formatDataSourceLabel", () => {
  it("labels Cursor SDK sessions distinctly when hasSdk is true", () => {
    expect(formatDataSourceLabel(false, "jsonl+tools", true)).toBe(
      "Cursor SDK + JSONL + agent-tools",
    );
    expect(formatDataSourceLabel(false, "jsonl", true)).toBe("Cursor SDK + JSONL");
    expect(formatDataSourceLabel(false, undefined, true)).toBe("Cursor SDK");
  });

  it("falls back to existing labels when hasSdk is not set", () => {
    expect(formatDataSourceLabel(false, "jsonl+tools")).toBe("JSONL + agent-tools");
    expect(formatDataSourceLabel(true, "jsonl+tools")).toBe("JSONL + agent-tools fallback");
    expect(formatDataSourceLabel(false, "jsonl")).toBe("JSONL transcript");
    expect(formatDataSourceLabel(true, "sqlite")).toBe("SQLite + JSONL supplement");
    expect(formatDataSourceLabel(false, "global-state")).toBe("Cursor global state");
    expect(formatDataSourceLabel(true)).toBe("SQLite + JSONL");
    expect(formatDataSourceLabel()).toBe("JSONL");
  });
});

describe("dashboard badge helpers", () => {
  it("uses distinct data source badge classes", () => {
    expect(dataSourceBadgeClass("jsonl")).toContain("terminal-orange");
    expect(dataSourceBadgeClass("global-state")).toContain("terminal-blue");
    expect(dataSourceBadgeClass("sqlite")).toContain("terminal-green");
    expect(dataSourceBadgeClass(undefined, true)).toContain("terminal-green");
    expect(dataSourceBadgeClass(undefined, false, true)).toContain("terminal-purple");
    expect(dataSourceBadgeClass()).toContain("terminal-dimmer");
  });

  it("hides default branches and shortens Cowork space ids", () => {
    expect(nonDefaultBranch("main")).toBeUndefined();
    expect(nonDefaultBranch("master")).toBeUndefined();
    expect(nonDefaultBranch("feature/dashboard")).toBe("feature/dashboard");
    expect(shortCoworkSpaceId("space_abcdef123")).toBe("abcdef");
    expect(shortCoworkSpaceId("space-xyz987")).toBe("xyz987");
    expect(shortCoworkSpaceId("abc")).toBe("abc");
  });
});

describe("provider display helpers", () => {
  it("labels Codex as a first-class provider", () => {
    expect(providerBadgeLabel("codex")).toBe("Codex");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerBadgeClass("codex")).toContain("terminal-purple");
    expect(providerBarClass("codex")).toBe("bg-terminal-purple");
    expect(providerFamily("codex")).toBe("purple");
  });
});

describe("isNetworkError", () => {
  it("treats fetch TypeErrors (failed/network/load) as network errors", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isNetworkError(new Error("Load failed"))).toBe(true);
  });

  it("does not treat application errors as network errors", () => {
    expect(isNetworkError(new Error("Generation failed"))).toBe(false);
    expect(isNetworkError("some string")).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it("does not treat an unrelated TypeError (a real bug) as retryable", () => {
    expect(isNetworkError(new TypeError("x is not a function"))).toBe(false);
  });
});

describe("getFriendlyErrorMessage", () => {
  it("rewrites raw network failures into an actionable message", () => {
    expect(getFriendlyErrorMessage(new TypeError("Failed to fetch"))).toMatch(
      /local vibe-replay server/i,
    );
  });

  it("passes through real application error messages", () => {
    expect(getFriendlyErrorMessage(new Error("Generation failed"))).toBe("Generation failed");
  });
});

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries a transient network rejection then succeeds", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("/api/sources", undefined, { baseDelayMs: 1 });
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries gateway statuses (503) from the dev proxy", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("/api/sources", undefined, { baseDelayMs: 1 });
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real application error response (500)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":"boom"}', { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("/api/generate", { method: "POST" }, { baseDelayMs: 1 });
    expect(resp.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries and rethrows the network error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("/api/sources", undefined, { retries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(/failed to fetch/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
