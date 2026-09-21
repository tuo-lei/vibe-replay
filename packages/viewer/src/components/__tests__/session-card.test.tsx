// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveFilterChip, SessionCard, SessionStatusRow } from "../SessionCard";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";

afterEach(cleanup);

/**
 * SessionCard.tsx is the shared session-card kit used by both the local
 * dashboard and the E2E live viewer. These tests pin the shared rendering so
 * a change here visibly affects both surfaces.
 */
describe("SessionStatusRow", () => {
  it("renders duration, prompts, tools, edits, cost, compactions and error state", () => {
    render(
      <SessionStatusRow
        durationMs={3723000}
        promptCount={5}
        toolCallCount={42}
        editCount={7}
        costEstimate={1.234}
        costTitle="token breakdown"
        compactionCount={3}
        errorCount={2}
      />,
    );
    const row = document.body.textContent ?? "";
    expect(row).toContain("1h 2m");
    expect(row).toContain("5 prompts");
    expect(row).toContain("42 tools");
    expect(row).toContain("7 edits");
    expect(row).toContain("$1.23");
    expect(row).toContain("3 compacts");
    expect(row).toContain("2 errors");
  });

  it("marks discovery estimates with a tilde", () => {
    render(<SessionStatusRow durationMs={60000} durationEstimated editCount={2} editEstimated />);
    const row = document.body.textContent ?? "";
    expect(row).toContain("~1m 0s");
    expect(row).toContain("~2 edits");
  });

  it("shows the clean-run badge only when known clean", () => {
    const { rerender } = render(<SessionStatusRow cleanRun />);
    expect(screen.getByText("✓ no errors")).toBeTruthy();
    rerender(<SessionStatusRow />);
    expect(screen.queryByText("✓ no errors")).toBeNull();
  });

  it("hides metrics that are absent", () => {
    render(<SessionStatusRow promptCount={1} />);
    const row = document.body.textContent ?? "";
    expect(row).toContain("1 prompt");
    expect(row).not.toContain("tools");
    expect(row).not.toContain("compacts");
  });

  it("renders an optional leading element (dashboard data-level icon)", () => {
    render(<SessionStatusRow leading={<span data-testid="leading">L</span>} promptCount={2} />);
    expect(screen.getByTestId("leading")).toBeTruthy();
  });
});

describe("ActiveFilterChip", () => {
  it("calls onRemove when clicked", () => {
    const onRemove = vi.fn();
    render(<ActiveFilterChip label="Provider" value="muse" onRemove={onRemove} />);
    fireEvent.click(screen.getByTitle("Remove Provider: muse"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

/**
 * The local dashboard and the live viewer render the same `SessionCard`
 * component. These tests pin that contract: given dashboard-shaped props and
 * live-shaped props, the outer shell and row structure must be identical, so
 * the two surfaces cannot visually drift apart again.
 */
describe("SessionCard shared shell", () => {
  const dashboardProps = {
    onOpen: () => {},
    provider: "muse",
    providerTitle: "Muse · claude-sonnet",
    title: "Fix the flaky test",
    timeMeta: "abc123 · 5m ago",
    prompts: ["make the test deterministic"],
    place: {
      project: "/home/lei/vibe-replay",
      projectLabel: "vibe-replay",
      branch: "feat/x",
      branchUrl: "https://github.com/tuo-lei/vibe-replay/tree/feat/x",
      repo: "tuo-lei/vibe-replay",
      repoUrl: "https://github.com/tuo-lei/vibe-replay",
    },
    status: { promptCount: 3, toolCallCount: 12, editCount: 4 },
  };

  // What the live viewer passes: relay summary fields plus the rows the relay
  // now ships (prompt previews, size, View CTA). Still no scan-data rows:
  // no usage details, no outcome facts, no Share/Redo.
  const liveProps = {
    onOpen: () => {},
    provider: "muse",
    providerTitle: "Muse · claude-sonnet",
    title: "Fix the flaky test",
    timeMeta: "5m ago",
    prompts: ["make the test deterministic", "also cover the retry path"],
    place: {
      project: "/home/lei/vibe-replay",
      projectLabel: "vibe-replay",
      branch: "feat/x",
      repo: "tuo-lei/vibe-replay",
    },
    status: {
      durationMs: 2700000,
      durationEstimated: true,
      promptCount: 3,
      toolCallCount: 12,
      editCount: 4,
      editEstimated: true,
    },
    middle: <span data-testid="live-size">22.8MB</span>,
    actions: (
      <button data-testid="live-view" type="button">
        View
      </button>
    ),
  };

  it("renders an identical outer shell for dashboard and live props", () => {
    stubBrowserAPIs();
    const { container: dashboardContainer, unmount } = render(<SessionCard {...dashboardProps} />);
    const dashboardShell = dashboardContainer.firstElementChild!;
    const dashboardClasses = [...dashboardShell.classList].sort().join(" ");
    const dashboardRows = dashboardShell.children.length;
    unmount();

    const { container: liveContainer } = render(<SessionCard {...liveProps} />);
    const liveShell = liveContainer.firstElementChild!;
    const liveClasses = [...liveShell.classList].sort().join(" ");

    // Same card element, same shell classes: one visual card, two data sources.
    expect(dashboardShell.tagName).toBe("DIV");
    expect(dashboardShell.getAttribute("role")).toBe("button");
    expect(liveClasses).toBe(dashboardClasses);
    // Dashboard fixture: header + 1 prompt preview + place + status.
    // Live fixture: header + 2 prompt previews + place + status + middle + footer.
    expect(dashboardRows).toBe(4);
    expect(liveShell.children.length).toBe(7);
  });

  it("renders prompt previews, the size middle-node and the View action for the live shape", () => {
    stubBrowserAPIs();
    const { container } = render(<SessionCard {...liveProps} />);
    expect(container.textContent).toContain("make the test deterministic");
    expect(container.textContent).toContain("also cover the retry path");
    expect(screen.getByTestId("live-size")).toBeTruthy();
    const viewButton = screen.getByTestId("live-view");
    expect(viewButton.textContent).toBe("View");
  });

  it("renders the branch/repo as links only when URLs are provided", () => {
    stubBrowserAPIs();
    const { container } = render(<SessionCard {...liveProps} />);
    // Live passes no URLs: plain text, no anchors.
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).toContain("feat/x");
    expect(container.textContent).toContain("tuo-lei/vibe-replay");
  });
});
