// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import TurnActivityTimeline from "../TurnActivityTimeline";

afterEach(cleanup);

describe("TurnActivityTimeline", () => {
  it("shows a left-to-right duration strip with semantic activity categories", () => {
    render(
      <TurnActivityTimeline
        scenes={[
          {
            type: "user-prompt",
            content: "Inspect the issue",
            timestamp: "2026-08-31T00:00:00.000Z",
          },
          {
            type: "tool-call",
            toolName: "Bash",
            input: { command: "pnpm test" },
            result: "passed",
            durationMs: 2_000,
            timestamp: "2026-08-31T00:00:02.000Z",
          },
          {
            type: "compaction-summary",
            content: "Earlier context condensed.",
            timestamp: "2026-08-31T00:00:05.000Z",
          },
          {
            type: "text-response",
            content: "The issue is fixed.",
            timestamp: "2026-08-31T00:00:05.500Z",
          },
          {
            type: "thinking",
            content: "Checking the result.",
            timestamp: "2026-08-31T00:00:05.500Z",
          },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: /Activity timeline/ })).toBeDefined();
    expect(screen.getByText("Tool execution")).toBeDefined();
    expect(screen.getByText("Compaction / context")).toBeDefined();
    expect(screen.getByText(/from timestamp gaps/)).toBeDefined();
    expect(screen.getByText(/prompt-to-assistant gaps are LLM wait/)).toBeDefined();
    expect(screen.getByText(/estimated compaction time/)).toBeDefined();
    expect(screen.getAllByTitle(/LLM wait/)[0].className).toContain("bg-terminal-thinking");
    expect(screen.getByTitle(/Compaction boundary/).className).toContain("bg-terminal-context");
  });

  it("shows whole-turn timing without pretending to split Cursor work", () => {
    render(
      <TurnActivityTimeline
        provider="cursor"
        turnStats={[{ turnIndex: 0, durationMs: 3_000 }]}
        scenes={[
          { type: "user-prompt", content: "Inspect", timestamp: "2026-08-31T00:00:00.000Z" },
          {
            type: "tool-call",
            toolName: "run_terminal_command_v2",
            input: { command: "pnpm test" },
            result: "ok",
            timestamp: "2026-08-31T00:00:01.000Z",
          },
          { type: "text-response", content: "Done", timestamp: "2026-08-31T00:00:10.000Z" },
        ]}
      />,
    );

    expect(screen.getByText("Agent turn (not split)")).toBeDefined();
    expect(screen.getByText(/Whole-turn timing only/)).toBeDefined();
    expect(screen.getByText(/whole-turn timing; not split/)).toBeDefined();
  });
});
