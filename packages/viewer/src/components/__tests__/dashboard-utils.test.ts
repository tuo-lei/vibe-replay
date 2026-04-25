import { describe, expect, it } from "vitest";
import {
  agentWorktreeParent,
  rollupProject,
  rollupTopProjects,
  type TopProjectEntry,
} from "../dashboard-utils";

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
      prCount: 0,
      memoryFileCount: 0,
      lastActivity: "2026-04-10T00:00:00Z",
      sessionsPerDay: { "2026-04-02": 1, "2026-04-10": 1 },
    });
    const worktreeB = makeProject({
      project: "~/Code/vibe-replay/.claude/worktrees/gallant-moser",
      sessions: 1,
      cost: 0.25,
      prompts: 2,
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
