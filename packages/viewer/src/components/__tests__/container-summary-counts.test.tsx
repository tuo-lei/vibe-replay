// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession, Scene } from "../../types";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import ConversationView from "../ConversationView";
import LandingHero from "../LandingHero";
import StatsPanel from "../StatsPanel";
import SummaryView from "../SummaryView";

beforeEach(stubBrowserAPIs);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function session(sceneCount: number): ReplaySession {
  const scenes: Scene[] = [
    { type: "user-prompt", content: "Update and check" },
    {
      type: "tool-call",
      toolName: "exec",
      input: {},
      result: "batch output",
      isToolContainer: true,
    },
    { type: "tool-call", toolName: "Edit", input: {}, result: "", resultUnavailable: true },
    { type: "tool-call", toolName: "Bash", input: {}, result: "", resultUnavailable: true },
    ...Array.from({ length: sceneCount - 4 }, (): Scene => ({
      type: "text-response",
      content: "Progress",
    })),
  ];
  return {
    meta: {
      sessionId: "container-summary",
      slug: "container-summary",
      provider: "codex",
      project: "fixture",
      cwd: "/fixture",
      startTime: "2026-01-01T00:00:00.000Z",
      stats: { sceneCount, userPrompts: 1, toolCalls: 2, thinkingBlocks: 0, durationMs: 0 },
    },
    scenes,
  };
}

describe.each([30, 500])("container summaries with %s scenes", (sceneCount) => {
  it("shows only nested calls in compact conversation cards", () => {
    const replay = session(sceneCount);
    render(
      <ConversationView
        scenes={replay.scenes}
        visibleCount={sceneCount}
        currentIndex={sceneCount - 1}
        effectivePrefs={{
          hideThinking: false,
          collapseAllTools: false,
          promptsOnly: false,
          compactAssistant: true,
        }}
      />,
    );
    expect(screen.getByText("2 tools")).toBeTruthy();
    expect(screen.queryByText("3 tools")).toBeNull();
    expect(screen.queryByText("exec")).toBeNull();
  });

  it("excludes the wrapper from landing preview counts", () => {
    render(<LandingHero session={session(sceneCount)} onStart={() => {}} />);
    expect(screen.getByText("2 tools")).toBeTruthy();
    expect(screen.queryByText("3 tools")).toBeNull();
    expect(screen.queryByText("exec")).toBeNull();
  });

  it("keeps the wrapper out of the top tools list", () => {
    render(<StatsPanel session={session(sceneCount)} />);
    expect(screen.getByText("Top Tools")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.queryByText("exec")).toBeNull();
  });
});

it("retains automated subagent edits without marking the preceding human turn heatmap", () => {
  const replay = session(30);
  replay.scenes = [
    { type: "user-prompt", content: "First request" },
    { type: "context-injection", content: "Automatic check", injectionType: "automation" },
    {
      type: "tool-call",
      toolName: "Agent",
      input: {},
      result: "",
      subAgent: {
        agentId: "automatic-child",
        agentType: "worker",
        description: "Automatic edit",
        prompt: "Edit source",
        toolCalls: 1,
        thinkingBlocks: 0,
        textResponses: 0,
        scenes: [
          {
            type: "tool-call",
            toolName: "Edit",
            input: {},
            result: "",
            diff: { filePath: "src/automatic.ts", oldContent: "old", newContent: "new" },
          },
        ],
      },
    },
    { type: "user-prompt", content: "Second request" },
    { type: "user-prompt", content: "Third request" },
  ];
  const { container } = render(<SummaryView session={replay} />);
  expect(screen.getByText("File Activity Heatmap")).toBeTruthy();
  expect(container.querySelector('[title="src/automatic.ts"]')).not.toBeNull();
  expect(container.querySelector('[title="automatic.ts — Turn 1: 1 edit"]')).toBeNull();
});
