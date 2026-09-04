import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProject } from "@vibe-replay/types";
import {
  agentRunWorkspaceParent,
  agentWorktreeParent,
  archiveSessionKey,
  cleanPrompt,
  dataSourceBadgeClass,
  fetchWithRetry,
  formatDataSourceLabel,
  formatTokens,
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
  replayArchiveKey,
  replaySuggestedTitle,
  rollupProject,
  rollupTopProjects,
  sessionIdentityKey,
  sessionPromptPreview,
  shouldRefreshCachedList,
  shortCoworkSpaceId,
  sourceDisplayTitle,
  sourceSuggestedTitle,
  transcriptStatusDescription,
  transcriptStatusLabel,
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

describe("agentRunWorkspaceParent", () => {
  it("rolls a per-run scratch directory up to the directory holding it", () => {
    expect(
      agentRunWorkspaceParent(
        "~/git/roblox/cursor-sdk/.cursor-sdk-control/artifacts/slack-inbox-0058bd61-76b9-4742-ba1d-ef3769cbdaa1",
      ),
    ).toBe("~/git/roblox/cursor-sdk/.cursor-sdk-control/artifacts");
  });

  it("matches a bare run id and a hex digest suffix alike", () => {
    expect(agentRunWorkspaceParent("/var/folders/sm/T/5433add3-d507-4e0a-8f71-1bd30c541913")).toBe(
      "/var/folders/sm/T",
    );
    expect(agentRunWorkspaceParent("~/sdk/worktrees/pr-review-ros-11883-14dac0782aab")).toBe(
      "~/sdk/worktrees",
    );
  });

  it("leaves real projects alone, including short hex-looking names", () => {
    expect(agentRunWorkspaceParent("~/git/roblox/vibe-replay")).toBeNull();
    expect(agentRunWorkspaceParent("~/git/roblox/ros-4")).toBeNull();
    // A PR number is not a run id, and neither is a digest under 12 chars.
    expect(agentRunWorkspaceParent("~/sdk/worktrees/pr-review-ros-11883")).toBeNull();
    expect(agentRunWorkspaceParent("~/Code/build-abc123")).toBeNull();
    expect(agentRunWorkspaceParent("~/Code/build-1735689600000")).toBeNull();
  });

  it("handles Windows project separators", () => {
    expect(
      agentRunWorkspaceParent(
        "C:\\Users\\test\\artifacts\\slack-inbox-5433add3-d507-4e0a-8f71-1bd30c541913",
      ),
    ).toBe("C:\\Users\\test\\artifacts");
    expect(agentRunWorkspaceParent("C:\\5433add3-d507-4e0a-8f71-1bd30c541913")).toBeNull();
  });

  it("returns null when there is no parent directory to roll up into", () => {
    expect(agentRunWorkspaceParent("/1777073568840abc")).toBeNull();
    expect(agentRunWorkspaceParent("Cowork")).toBeNull();
    expect(agentRunWorkspaceParent("")).toBeNull();
  });

  it("feeds rollupProject alongside the Claude worktree rule", () => {
    expect(rollupProject("~/sdk/artifacts/slack-inbox-14dac0782aab")).toBe("~/sdk/artifacts");
    expect(rollupProject("~/Code/vibe-replay/.claude/worktrees/affectionate-darwin-968d37")).toBe(
      "~/Code/vibe-replay",
    );
    expect(rollupProject("~/Code/vibe-replay")).toBe("~/Code/vibe-replay");
  });
});

describe("Cursor SDK project identity", () => {
  it("groups hyphenated and underscored PR worktrees by repository", () => {
    const identity = classifyProject(
      "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github-pr-review-Roblox-ros-13473-6873354cf2f3",
      {
        provider: "cursor",
        hasSdk: true,
        sdkAgentName:
          "workflow-recovery-github-pr-review-github_pr_review-Roblox-ros-13473-6873354cf2f3",
        sdkWorkspaceRef:
          "/Users/tuo/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github_pr_review-Roblox-ros-13473-6873354cf2f3",
      },
    );
    const equivalent = classifyProject(
      "~/git/roblox/cursor-sdk/repos/cursor-coworktrees/worktrees/github_pr_review-Roblox-ros-14156-f4ca4e119f1f",
      {
        provider: "cursor",
        hasSdk: true,
        sdkAgentName: "github-pr-review-github_pr_review-Roblox-ros-14156-f4ca4e119f1f",
      },
    );

    expect(identity).toMatchObject({
      key: "cursor-sdk:github-pr-review:Roblox/ros",
      kind: "cursor-sdk-automation",
      isAutomated: true,
      displayName: "Automated · Roblox/ros · GitHub PR review",
      repository: "Roblox/ros",
      prNumber: 13473,
    });
    expect(equivalent.key).toBe(identity.key);
    expect(equivalent.prNumber).toBe(14156);
  });

  it("preserves hyphens in inferred repository names", () => {
    const identity = classifyProject(
      "~/cursor-sdk/repos/cursor-coworktrees/worktrees/github-pr-review-Roblox-vibe-replay-912",
      { hasSdk: true },
    );

    expect(identity.repository).toBe("Roblox/vibe-replay");
    expect(identity.key).toBe("cursor-sdk:github-pr-review:Roblox/vibe-replay");
    expect(identity.prNumber).toBe(912);
  });

  it("does not put an absolute SDK workspace path in an unknown identity key", () => {
    const identity = classifyProject("~/cursor-sdk/repos/cursor-coworktrees/worktrees/agent-abc", {
      hasSdk: true,
      sdkWorkspaceRef: "/Users/tuo/cursor-sdk/repos/cursor-coworktrees/worktrees/agent-abc",
    });

    expect(identity.key).toBe("cursor-sdk:cursor-sdk:~/cursor-sdk/repos");
  });

  it("rolls Cursor control-plane context worktrees up to the SDK project", () => {
    const identity = classifyProject(
      "~/git/roblox/cursor-sdk/.cursor-sdk-control/context-worktrees/google-drive-search-run",
      { hasSdk: true, sdkAgentName: "google-drive-search-run" },
    );

    expect(identity.key).toBe("cursor-sdk:google-drive-search:~/git/roblox/cursor-sdk");
  });

  it("does not treat a numeric PR directory as a generic run", () => {
    expect(classifyProject("~/sdk/worktrees/pr-review-ros-11883")).toMatchObject({
      key: "~/sdk/worktrees/pr-review-ros-11883",
      kind: "project",
      isAutomated: false,
    });
  });
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

  it("does not merge identical project paths across SSH locations", () => {
    const result = rollupTopProjects([
      makeProject({ project: "~/Code/shared", sessions: 2 }),
      makeProject({
        project: "~/Code/shared",
        sessions: 3,
        location: { kind: "ssh", id: "remote-a", label: "Remote A" },
      }),
      makeProject({
        project: "~/Code/shared",
        sessions: 4,
        location: { kind: "ssh", id: "remote-b", label: "Remote B" },
      }),
    ]);

    expect(result).toHaveLength(3);
    expect(result.find((project) => !project.location)?.sessions).toBe(2);
    expect(result.find((project) => project.location?.id === "remote-a")?.sessions).toBe(3);
    expect(result.find((project) => project.location?.id === "remote-b")?.sessions).toBe(4);
  });

  it("can preserve agent run workspaces for the explicit Projects toggle", () => {
    const result = rollupTopProjects(
      [
        makeProject({ project: "/tmp/review-abcdef123456", sessions: 2 }),
        makeProject({ project: "/tmp", sessions: 3 }),
      ],
      { rollupAgentRuns: false },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: "/tmp/review-abcdef123456", sessions: 2 }),
        expect.objectContaining({ project: "/tmp", sessions: 3 }),
      ]),
    );
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

describe("archive keys", () => {
  it("keeps local and SSH sessions with the same slug separate", () => {
    const remote = { kind: "ssh" as const, id: "remote-a", label: "Remote A" };

    expect(archiveSessionKey("shared-slug")).toBe("shared-slug");
    expect(archiveSessionKey("shared-slug", remote)).not.toBe("shared-slug");
    expect(archiveSessionKey("shared-slug", remote)).toBe(
      archiveSessionKey("shared-slug", { ...remote, label: "Different label" }),
    );
  });

  it("maps a location-scoped replay directory back to its source slug", () => {
    const remote = { kind: "ssh" as const, id: "remote-a", label: "Remote A" };
    const replay = {
      slug: "shared-slug--ssh-output-hash",
      sourceSlug: "shared-slug",
      location: remote,
    };

    expect(replayArchiveKey(replay)).toBe(archiveSessionKey("shared-slug", remote));
    expect(replayArchiveKey({ ...replay, sourceSlug: undefined })).toBe(
      archiveSessionKey(replay.slug, remote),
    );
  });
});

describe("session identity keys", () => {
  it("maps a location-scoped replay slug back to its source slug", () => {
    const location = { kind: "ssh" as const, id: "remote-a", label: "Remote A" };

    expect(
      sessionIdentityKey({
        provider: "codex",
        slug: "source-slug",
        location,
      }),
    ).toBe(
      sessionIdentityKey({
        provider: "codex",
        slug: "source-slug--ssh-output--id-session",
        sourceSlug: "source-slug",
        location,
      }),
    );
  });
});

describe("cache response helpers", () => {
  it("accepts cached list payloads and normalizes missing cachedAt", () => {
    expect(parseCachedList<{ slug: string }>({ sessions: [{ slug: "a" }] })).toEqual({
      sessions: [{ slug: "a" }],
      cachedAt: undefined,
      discoveredAt: undefined,
      stale: undefined,
      staleProviders: undefined,
      failedProviders: undefined,
    });
    expect(
      parseCachedList({
        sessions: [],
        cachedAt: "2026-05-01T00:00:00.000Z",
        discoveredAt: "2026-05-01T00:00:01.000Z",
        stale: true,
        staleProviders: ["pi", 42],
        failedProviders: ["ssh:remote-dev", null],
      }),
    ).toEqual({
      sessions: [],
      cachedAt: "2026-05-01T00:00:00.000Z",
      discoveredAt: "2026-05-01T00:00:01.000Z",
      stale: true,
      staleProviders: ["pi"],
      failedProviders: ["ssh:remote-dev"],
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

  it("refreshes stale cached source-session responses even when cachedAt is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));

    expect(
      shouldRefreshCachedList({
        sessions: [],
        cachedAt: "2026-05-01T09:59:00.000Z",
        discoveredAt: "2026-05-01T09:59:00.000Z",
        stale: true,
        staleProviders: ["pi"],
      }),
    ).toBe(true);
    expect(
      shouldRefreshCachedList({
        sessions: [],
        cachedAt: "2026-05-01T09:59:00.000Z",
      }),
    ).toBe(false);
    expect(
      shouldRefreshCachedList({
        sessions: [],
        cachedAt: "2026-05-01T09:59:00.000Z",
        discoveredAt: "2026-05-01T09:54:00.000Z",
      }),
    ).toBe(true);
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

  it("keeps a single prompt even when it matches the title", () => {
    const prompts = sessionPromptPreview(
      makeSource({
        firstPrompt: "Build the dashboard",
        prompts: [],
      }),
      null,
      "Build the dashboard",
    );

    expect(prompts).toEqual(["Build the dashboard"]);
  });

  it("drops leading continuation prompts when later context exists", () => {
    const prompts = sessionPromptPreview(
      makeSource({
        firstPrompt: "",
        prompts: ["Then add tests", "Ship docs"],
      }),
    );

    expect(prompts).toEqual(["Ship docs"]);
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
        stats: { sceneCount: 3, userPrompts: 1, toolCalls: 2 },
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

  it("keeps an explicit source title ahead of stale scan metadata", () => {
    const source = makeSource({
      provider: "codex",
      title: "Renamed thread",
      firstPrompt: "Original prompt text",
    });

    expect(sourceDisplayTitle(source, { title: "Old generated title" })).toBe("Renamed thread");
  });

  it("falls back from Cursor placeholder titles to the first prompt", () => {
    const source = makeSource({
      title: "New Agent",
      firstPrompt: "Inspect the Gateway Lens capture flow",
      replay: {
        slug: "source-slug",
        title: "New Agent",
        provider: "cursor",
        project: "~/Code/app",
        startTime: "2026-05-01T10:00:00.000Z",
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
        hasAnnotations: false,
        annotationCount: 0,
        messages: [],
      },
    });

    expect(sourceSuggestedTitle(source)).toBe("Inspect the Gateway Lens capture flow");
    expect(sourceDisplayTitle(source, { title: "New Agent" })).toBe(
      "Inspect the Gateway Lens capture flow",
    );
  });

  it("skips Cursor placeholder prompt previews when choosing a title", () => {
    const source = makeSource({
      title: "New Agent",
      prompts: ["New Agent", "Inspect the Gateway Lens capture flow"],
      firstPrompt: "Fallback prompt",
    });

    expect(sourceDisplayTitle(source)).toBe("Inspect the Gateway Lens capture flow");
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

describe("formatTokens", () => {
  it("formats magnitudes with K/M suffixes", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(742)).toBe("742");
    expect(formatTokens(8_655)).toBe("9K");
    expect(formatTokens(999_251)).toBe("999K");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  it("does not emit '1000K' near the 1M boundary", () => {
    expect(formatTokens(999_500)).toBe("1.0M");
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});

describe("dashboard badge helpers", () => {
  it("uses distinct data source badge classes", () => {
    expect(dataSourceBadgeClass("jsonl")).toContain("terminal-orange");
    expect(dataSourceBadgeClass("jsonl+tools")).toContain("terminal-orange");
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

  it("explains source transcripts that cannot produce a replay", () => {
    expect(transcriptStatusLabel("no-prompts")).toBe("no replayable prompts");
    expect(transcriptStatusDescription("no-prompts")).toContain("meaningful human prompt");
    expect(transcriptStatusLabel("unreadable")).toBe("unreadable transcript");
    expect(transcriptStatusDescription("unreadable")).toContain("unavailable");
    expect(transcriptStatusLabel()).toBeUndefined();
    expect(transcriptStatusDescription()).toBeUndefined();
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

  it("labels Pi as a first-class provider", () => {
    expect(providerBadgeLabel("pi")).toBe("Pi");
    expect(providerDisplayName("pi")).toBe("Pi");
    expect(providerBadgeClass("pi")).toContain("terminal-cyan");
    expect(providerBarClass("pi")).toBe("bg-terminal-cyan");
    expect(providerFamily("pi")).toBe("cyan");
  });

  it("labels OpenCode as a first-class provider", () => {
    expect(providerBadgeLabel("opencode")).toBe("OpenCode");
    expect(providerDisplayName("opencode")).toBe("OpenCode");
    expect(providerBadgeClass("opencode")).toBe("bg-terminal-green-subtle text-terminal-green");
    expect(providerBarClass("opencode")).toBe("bg-terminal-green");
    expect(providerFamily("opencode")).toBe("green");
  });

  it("labels Hermes as a first-class provider", () => {
    expect(providerBadgeLabel("hermes")).toBe("Hermes");
    expect(providerDisplayName("hermes")).toBe("Hermes");
    expect(providerBadgeClass("hermes")).toBe("bg-terminal-red-subtle text-terminal-red");
    expect(providerBarClass("hermes")).toBe("bg-terminal-red");
    expect(providerFamily("hermes")).toBe("red");
  });

  it("gives each Claude sub-kind a distinct warm hue", () => {
    expect(providerFamily("claude-code")).toBe("orange");
    expect(providerFamily("claude-cowork")).toBe("sienna");
    expect(providerFamily("claude-desktop")).toBe("yellow");

    expect(providerBadgeClass("claude-code")).toContain("terminal-orange");
    expect(providerBadgeClass("claude-cowork")).toContain("terminal-sienna");
    expect(providerBadgeClass("claude-desktop")).toContain("terminal-yellow");

    expect(providerBarClass("claude-code")).toBe("bg-terminal-orange");
    expect(providerBarClass("claude-cowork")).toBe("bg-terminal-sienna");
    expect(providerBarClass("claude-desktop")).toBe("bg-terminal-yellow");
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
