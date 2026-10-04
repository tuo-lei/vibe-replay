// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SessionRelationshipsView from "../SessionRelationshipsView";
import { useRelationshipData } from "../../hooks/useRelationshipData";

vi.mock("../../hooks/useRelationshipData", () => ({ useRelationshipData: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("does not draw an execution-duration rail from a dot conversation's chat bounds", () => {
  const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  vi.mocked(useRelationshipData).mockReturnValue({
    sessions: [
      {
        sessionId: "synthetic-dot-timeline",
        provider: "dot",
        project: "dot conversations",
        slug: "synthetic-dot-timeline",
        title: "dot conversation",
        startTime,
        endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        promptCount: 1,
        toolCallCount: 0,
        editCount: 0,
        filesModified: [],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
    ],
    loading: false,
    error: null,
  });
  render(<SessionRelationshipsView view="timeline" />);
  const bar = screen.getByRole("button", { name: "Open dot conversation" });
  expect(screen.queryByTitle("actual duration")).toBeNull();
  fireEvent.mouseEnter(bar, { clientX: 100, clientY: 100 });
  const tooltip = document.body.querySelector(".fixed");
  expect(tooltip?.textContent).toContain("Execution duration unavailable");
  expect(tooltip?.textContent).not.toContain("→");
  expect(tooltip?.textContent).not.toContain("estimated time");
});
