// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionRelationshipsView from "../SessionRelationshipsView";
import { useRelationshipData, type ScanResultSession } from "../../hooks/useRelationshipData";

vi.mock("../../hooks/useRelationshipData", () => ({
  useRelationshipData: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function session(): ScanResultSession {
  const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    sessionId: "hover-session",
    provider: "claude-code",
    project: "~/project",
    slug: "hover-session",
    title: "Hover session",
    startTime,
    endTime: startTime,
    durationMs: 60_000,
    promptCount: 1,
    toolCallCount: 1,
    editCount: 0,
    filesModified: [],
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
  };
}

describe("SessionRelationshipsView timeline tooltip", () => {
  it("renders the hover card outside the scrollable timeline pane", () => {
    vi.mocked(useRelationshipData).mockReturnValue({
      sessions: [session()],
      loading: false,
      error: null,
    });

    const { container } = render(<SessionRelationshipsView view="timeline" />);
    const timelinePane = container.querySelector("div.overflow-y-auto");
    const bar = screen.getByRole("button", { name: "Open Hover session" });

    expect(timelinePane).not.toBeNull();
    fireEvent.mouseEnter(bar, { clientX: 100, clientY: 100 });

    const tooltip = document.body.querySelector(".fixed");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain("Hover session");
    expect(tooltip?.parentElement).toBe(document.body);
    expect(timelinePane?.contains(tooltip)).toBe(false);
  });
});
