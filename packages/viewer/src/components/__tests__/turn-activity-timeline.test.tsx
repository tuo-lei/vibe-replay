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
    expect(screen.getByText(/Timestamp gaps and provider-recorded tool runtimes/)).toBeDefined();
  });
});
