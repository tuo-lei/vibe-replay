import { describe, expect, it } from "vitest";
import { parseClaudeCodeLines } from "../src/claude-code/parser.js";
import { transformToReplay } from "./helpers/transform.js";

const baseUserMessage = (content: string, ts: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content },
    timestamp: ts,
    sessionId: "extras-session",
    slug: "extras-slug",
    cwd: "/Users/test/project",
    gitBranch: "main",
  });

describe("Extra Claude Code metadata extraction", () => {
  it("falls back to ai-title when no custom-title is present", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Refactor auth middleware",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.title).toBe("Refactor auth middleware");
  });

  it("prefers custom-title over ai-title", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "ai-title",
        aiTitle: "AI generated title",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "custom-title",
        customTitle: "User chosen title",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.title).toBe("User chosen title");
  });

  it("prefers custom-title even when ai-title appears after it", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "custom-title",
        customTitle: "User chosen title",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "ai-title",
        aiTitle: "AI generated title",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.title).toBe("User chosen title");
  });

  it("captures agent-name", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "agent-name",
        agentName: "auth-refactor-bot",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.agentName).toBe("auth-refactor-bot");
  });

  it("agent-name is latest-wins when multiple entries appear", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "agent-name",
        agentName: "first-name",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "agent-name",
        agentName: "renamed-bot",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.agentName).toBe("renamed-bot");
  });

  it("standalone permission-mode entry overrides message-level value", async () => {
    const lines = [
      // Message-level permissionMode = "default"
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        timestamp: "2026-04-01T00:00:00Z",
        sessionId: "extras-session",
        slug: "extras-slug",
        cwd: "/Users/test/project",
        permissionMode: "default",
      }),
      // Standalone entry switches to bypass
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "bypassPermissions",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.permissionMode).toBe("bypassPermissions");
  });

  it("captures worktree state and clears it on null", async () => {
    const enter = await parseClaudeCodeLines([
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "worktree-state",
        worktreeSession: {
          worktreeName: "feat-x",
          worktreePath: "/Users/test/project/.worktrees/feat-x",
          worktreeBranch: "claude/feat-x",
          sessionId: "extras-session",
        },
        sessionId: "extras-session",
      }),
    ]);
    expect(enter.worktree).toEqual({
      name: "feat-x",
      path: "/Users/test/project/.worktrees/feat-x",
      branch: "claude/feat-x",
    });

    const exited = await parseClaudeCodeLines([
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "worktree-state",
        worktreeSession: {
          worktreeName: "feat-x",
          worktreePath: "/Users/test/project/.worktrees/feat-x",
          sessionId: "extras-session",
        },
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "worktree-state",
        worktreeSession: null,
        sessionId: "extras-session",
      }),
    ]);
    expect(exited.worktree).toBeUndefined();
  });

  it("counts queue-operation enqueue and remove events", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-04-01T00:00:01Z",
        sessionId: "extras-session",
        content: "queued message 1",
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-04-01T00:00:02Z",
        sessionId: "extras-session",
        content: "queued message 2",
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "2026-04-01T00:00:03Z",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-04-01T00:00:04Z",
        sessionId: "extras-session",
      }),
    ];
    const result = await parseClaudeCodeLines(lines);
    expect(result.queueOperationStats).toEqual({ enqueued: 2, cancelled: 1 });
  });

  it("plumbs new metadata through transformToReplay", async () => {
    const lines = [
      baseUserMessage("hi", "2026-04-01T00:00:00Z"),
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Refactor",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "agent-name",
        agentName: "refactor-bot",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "worktree-state",
        worktreeSession: {
          worktreeName: "feat-x",
          worktreePath: "/Users/test/project/.worktrees/feat-x",
          sessionId: "extras-session",
        },
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-04-01T00:00:01Z",
        sessionId: "extras-session",
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "remove",
        timestamp: "2026-04-01T00:00:02Z",
        sessionId: "extras-session",
      }),
    ];
    const parsed = await parseClaudeCodeLines(lines);
    const replay = transformToReplay(parsed, "claude-code", "~/test");

    expect(replay.meta.title).toBe("Refactor");
    expect(replay.meta.agentName).toBe("refactor-bot");
    expect(replay.meta.worktree?.name).toBe("feat-x");
    expect(replay.meta.queueOperationStats).toEqual({ enqueued: 1, cancelled: 1 });
  });

  it("omits new fields when no relevant entries are present (backward compat)", async () => {
    const lines = [baseUserMessage("hi", "2026-04-01T00:00:00Z")];
    const parsed = await parseClaudeCodeLines(lines);
    const replay = transformToReplay(parsed, "claude-code", "~/test");

    expect(parsed.agentName).toBeUndefined();
    expect(parsed.worktree).toBeUndefined();
    expect(parsed.queueOperationStats).toBeUndefined();
    expect(replay.meta).not.toHaveProperty("agentName");
    expect(replay.meta).not.toHaveProperty("worktree");
    expect(replay.meta).not.toHaveProperty("queueOperationStats");
  });
});
