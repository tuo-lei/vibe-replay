// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveFilterChip, SessionStatusRow } from "../SessionCard";

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
