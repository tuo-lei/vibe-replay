// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScanFailureNotice } from "../InsightsPanel";

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
