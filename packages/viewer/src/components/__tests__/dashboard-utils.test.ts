import { describe, expect, it } from "vitest";
import { agentWorktreeParent, rollupProject } from "../dashboard-utils";

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
