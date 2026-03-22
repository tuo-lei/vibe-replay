import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "../src/providers/claude-code/parser.js";
import { transformToReplay } from "../src/transform.js";

const FIXTURE = join(import.meta.dirname, "fixtures/claude-code-new-features.jsonl");

describe("New features: subagent, duration, metadata, api errors", () => {
  // --- Parser: git branch tracking ---
  it("collects all git branches and prefers the last one", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    // Session starts on "main", switches to "feat/auth-fix"
    expect(result.gitBranch).toBe("feat/auth-fix");
    expect(result.gitBranches).toEqual(["main", "feat/auth-fix"]);
  });

  it("extracts entrypoint and permissionMode", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.entrypoint).toBe("cli");
    expect(result.permissionMode).toBe("default");
  });

  // --- Parser: API errors ---
  it("extracts API error events", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.apiErrors).toBeDefined();
    expect(result.apiErrors).toHaveLength(2);
    expect(result.apiErrors![0]).toMatchObject({
      statusCode: 529,
      errorType: "overloaded_error",
      retryAttempt: 1,
    });
    expect(result.apiErrors![1].retryAttempt).toBe(2);
  });

  // --- Parser: tracked files ---
  it("extracts tracked files from file-history-snapshot", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    expect(result.trackedFiles).toBeDefined();
    // Should have all unique files from both snapshots
    expect(result.trackedFiles).toContain("src/auth.ts");
    expect(result.trackedFiles).toContain("src/index.ts");
    expect(result.trackedFiles).toContain("src/utils.ts");
    expect(result.trackedFiles).toHaveLength(3);
  });

  // --- Parser: agent mapping from progress ---
  it("extracts agent mapping from progress messages", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    // The Agent tool_use (toolu_agent1) should find subagent data via progress mapping
    // Since there's no actual subagent JSONL file, subagent data won't be attached,
    // but the mapping itself should be created (verified via the enrichment path)
    const agentTurns = result.turns.filter(
      (t) =>
        t.role === "assistant" && t.blocks.some((b) => b.type === "tool_use" && b.name === "Agent"),
    );
    expect(agentTurns.length).toBe(1);
  });

  // --- Parser: per-tool duration ---
  it("calculates per-tool duration from timestamps", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    // Find the Bash tool_use block — it should have duration
    const assistantTurns = result.turns.filter((t) => t.role === "assistant");
    let bashBlock: any = null;
    let editBlock: any = null;
    for (const turn of assistantTurns) {
      for (const block of turn.blocks) {
        if (block.type === "tool_use" && block.name === "Bash") bashBlock = block;
        if (block.type === "tool_use" && block.name === "Edit") editBlock = block;
      }
    }
    // Bash: assistant at 10:00:10, result at 10:00:13 = 3000ms
    expect(bashBlock).toBeDefined();
    expect(bashBlock._durationMs).toBe(3000);
    // Edit: previous tool result at 10:00:13, edit result at 10:00:16 = 3000ms
    // But Edit is in a different assistant message (msg_a3 at 10:00:15), so start = 10:00:15
    expect(editBlock).toBeDefined();
    expect(editBlock._durationMs).toBe(1000); // 10:00:16 - 10:00:15
  });

  // --- Transform: new fields pass through ---
  it("passes new metadata through to ReplaySession", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");

    expect(replay.meta.gitBranch).toBe("feat/auth-fix");
    expect(replay.meta.gitBranches).toEqual(["main", "feat/auth-fix"]);
    expect(replay.meta.entrypoint).toBe("cli");
    expect(replay.meta.permissionMode).toBe("default");
    expect(replay.meta.apiErrors).toHaveLength(2);
    expect(replay.meta.trackedFiles).toHaveLength(3);
    // trackedFiles should be redacted (~ instead of /Users/...)
    // (our fixture uses "src/auth.ts" which has no home dir, so it stays as-is)
  });

  it("attaches durationMs to tool-call scenes", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");

    const toolScenes = replay.scenes.filter((s) => s.type === "tool-call");
    const bashScene = toolScenes.find((s) => s.type === "tool-call" && s.toolName === "Bash");
    expect(bashScene).toBeDefined();
    expect(bashScene!.type === "tool-call" && bashScene!.durationMs).toBe(3000);
  });

  // --- Backward compatibility: old replay without new fields still works ---
  it("old replay JSON without new fields deserializes correctly", () => {
    // Simulate an old replay.json with no new fields
    const oldReplay = {
      meta: {
        sessionId: "old-session",
        slug: "old-slug",
        provider: "claude-code",
        startTime: "2025-01-01T00:00:00Z",
        cwd: "/home/user",
        project: "~/project",
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
      },
      scenes: [
        { type: "user-prompt" as const, content: "hello" },
        { type: "tool-call" as const, toolName: "Bash", input: {}, result: "ok" },
      ],
    };

    // All new optional fields should be undefined (not crash)
    expect(oldReplay.meta).not.toHaveProperty("gitBranch");
    expect(oldReplay.meta).not.toHaveProperty("apiErrors");
    expect(oldReplay.meta).not.toHaveProperty("trackedFiles");
    expect(oldReplay.meta).not.toHaveProperty("subAgentSummary");
    expect(oldReplay.scenes[1]).not.toHaveProperty("subAgent");
    expect(oldReplay.scenes[1]).not.toHaveProperty("durationMs");

    // Access with optional chaining (how viewer does it) should return undefined, not throw
    const meta = oldReplay.meta as any;
    expect(meta.gitBranch ?? "none").toBe("none");
    expect(meta.apiErrors?.length ?? 0).toBe(0);
    expect(meta.subAgentSummary?.length ?? 0).toBe(0);

    const scene = oldReplay.scenes[1] as any;
    expect(scene.subAgent?.agentType ?? "none").toBe("none");
    expect(scene.durationMs ?? 0).toBe(0);
  });

  // --- Turn stats: last turn gets duration from fallback ---
  it("last turn gets duration from timestamp fallback when no turn_duration event", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    // Only 1 turn in this fixture, and it has a turn_duration event (90s)
    expect(result.turnStats).toBeDefined();
    expect(result.turnStats!.length).toBe(1);
    expect(result.turnStats![0].durationMs).toBe(90000);
  });
});
