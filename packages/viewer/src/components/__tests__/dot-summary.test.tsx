// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ReplaySession } from "../../types";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import SummaryView from "../SummaryView";
import StatsPanel from "../StatsPanel";

beforeEach(stubBrowserAPIs);
afterEach(cleanup);
it.each([SummaryView, StatsPanel])(
  "shows unavailable dot execution counts while keeping native measured zero",
  (View) => {
    const session = (provider: string): ReplaySession => ({
      meta: {
        sessionId: "synthetic-import",
        slug: "synthetic-import",
        provider,
        cwd: "",
        project: "synthetic project",
        startTime: "2026-10-01T00:00:00Z",
        stats: { userPrompts: 1, toolCalls: 0, sceneCount: 1 },
      },
      scenes: [{ type: "user-prompt", content: "Synthetic prompt" }],
      annotations: [],
    });
    const { unmount } = render(<View session={session("dot")} />);
    for (const label of ["Tool Calls", "Files Modified"]) {
      expect(screen.getByText(label).parentElement?.textContent).toContain("unavailable");
    }
    for (const table of screen.queryAllByRole("table")) {
      expect(within(table).getAllByText("unavailable")).toHaveLength(1);
    }
    unmount();
    render(<View session={session("codex")} />);
    for (const label of ["Tool Calls", "Files Modified"]) {
      expect(screen.getByText(label).parentElement?.textContent).toContain("0");
      expect(screen.getByText(label).parentElement?.textContent).not.toContain("unavailable");
    }
  },
);
