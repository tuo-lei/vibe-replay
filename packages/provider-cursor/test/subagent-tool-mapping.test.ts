import { describe, expect, it } from "vitest";
import { transformToReplay } from "./helpers/transform.js";
import { mapCursorToolName, mapToolArgs } from "../src/cursor/tool-mapping.js";

// Regression coverage for Cursor delegation going unrecorded.
//
// Cursor IDE transcripts name the delegation tool `Subagent` (SDK payloads use
// `Task`/`task_v2`). `Subagent` was missing from the tool-name table, so it
// passed through unmapped and every downstream consumer that keys on the
// canonical `"Agent"` name silently saw zero subagents: `meta.subAgentSummary`
// stayed empty, `scan.subAgentCount` reported 0 for every Cursor session, and
// the viewer's sub-agent panel never rendered.

describe("Cursor delegation tool-name mapping", () => {
  it("maps the IDE transcript name `Subagent` to the canonical Agent tool", () => {
    expect(mapCursorToolName("Subagent")).toBe("Agent");
  });

  it("keeps mapping the SDK delegation names to the canonical Agent tool", () => {
    expect(mapCursorToolName("Task")).toBe("Agent");
    expect(mapCursorToolName("task_v2")).toBe("Agent");
  });
});

describe("Cursor delegation argument normalization", () => {
  it("normalizes the snake_case subagent_type written by IDE transcripts", () => {
    expect(
      mapToolArgs("Subagent", {
        description: "Explore auth flow",
        prompt: "Find the auth middleware",
        subagent_type: "explore",
        run_in_background: false,
      }),
    ).toEqual({
      description: "Explore auth flow",
      prompt: "Find the auth middleware",
      subagent_type: "explore",
    });
  });

  it("still normalizes the camelCase subagentType written by SDK payloads", () => {
    expect(
      mapToolArgs("Task", {
        description: "Explore auth flow",
        prompt: "Find the auth middleware",
        subagentType: "explore",
      }),
    ).toEqual({
      description: "Explore auth flow",
      prompt: "Find the auth middleware",
      subagent_type: "explore",
    });
  });

  it("preserves an explicit per-subagent model so seat-level cost stays visible", () => {
    expect(
      mapToolArgs("Subagent", {
        description: "Explore auth flow",
        prompt: "Find the auth middleware",
        subagent_type: "explore",
        model: "composer-2.5",
      }),
    ).toEqual({
      description: "Explore auth flow",
      prompt: "Find the auth middleware",
      subagent_type: "explore",
      model: "composer-2.5",
    });
  });
});

describe("Cursor delegation end-to-end", () => {
  it("records a subagent summary for a raw `Subagent` tool call", () => {
    const replay = transformToReplay(
      {
        sessionId: "cursor-subagent-session",
        slug: "cursor-s",
        cwd: "",
        turns: [
          {
            role: "user",
            blocks: [{ type: "text", text: "Find where auth is wired up" }],
          },
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "subagent-1",
                name: mapCursorToolName("Subagent"),
                input: mapToolArgs("Subagent", {
                  subagent_type: "explore",
                  description: "Explore auth flow",
                  prompt: "Find the auth middleware",
                  model: "composer-2.5",
                }),
              },
            ],
          },
        ],
      },
      "cursor",
      "~/test",
    );

    const agentScene = replay.scenes.find(
      (scene) => scene.type === "tool-call" && scene.toolName === "Agent",
    );
    expect(agentScene).toBeDefined();
    expect(agentScene?.type === "tool-call" && agentScene.subAgent?.agentType).toBe("Explore");
    expect(replay.meta.subAgentSummary).toEqual([
      {
        agentId: "subagent-1",
        agentType: "Explore",
        description: "Explore auth flow",
        toolCalls: 0,
        model: "composer-2.5",
      },
    ]);
  });
});
