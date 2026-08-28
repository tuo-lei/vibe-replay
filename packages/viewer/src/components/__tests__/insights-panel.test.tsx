// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScanFailureNotice, ScanProgressBar } from "../InsightsPanel";

afterEach(() => cleanup());

describe("ScanFailureNotice", () => {
  it("explains when background insights are incomplete", () => {
    render(<ScanFailureNotice failedProviders={["claude-cowork", "cursor"]} />);

    expect(screen.getByRole("status").textContent).toContain("Insights may be incomplete");
    expect(screen.getByRole("status").textContent).toContain("Claude Cowork, Cursor");
  });

  it("renders nothing when all providers were scanned", () => {
    const { container } = render(<ScanFailureNotice failedProviders={[]} />);

    expect(container.innerHTML).toBe("");
  });
});

describe("ScanProgressBar", () => {
  it("surfaces deferred usage indexing even after the fast scan completes", () => {
    render(
      <ScanProgressBar
        status={{
          running: false,
          scanned: 10,
          total: 10,
          resultCount: 10,
          usageBackfill: { running: true, scanned: 2, total: 8 },
        }}
      />,
    );

    expect(screen.getByText("Indexing usage... 2/8")).toBeDefined();
  });
});
