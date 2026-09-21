// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveFilterChip, SessionCard, SessionStatusRow } from "../SessionCard";
import { LiveSessionCard } from "../../live/LiveSessionCard";
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
  // now ships (prompt previews, slug, size + storage badge, data-level icon,
  // View CTA). Still no scan-data rows: no usage details, no error state,
  // no Share/Redo — those slots stay honestly empty.
  const liveProps = {
    onOpen: () => {},
    provider: "muse",
    providerTitle: "Muse · claude-sonnet",
    title: "Fix the flaky test",
    timeMeta: "a9080f00 · 5m ago",
    prompts: ["make the test deterministic", "also cover the retry path"],
    place: {
      project: "/home/lei/vibe-replay",
      projectLabel: "vibe-replay",
      branch: "feat/x",
      repo: "tuo-lei/vibe-replay",
    },
    statusLeading: <span data-testid="data-level-icon" />,
    status: {
      durationMs: 2700000,
      durationEstimated: true,
      promptCount: 3,
      toolCallCount: 12,
      editCount: 4,
      editEstimated: true,
    },
    facts: (
      <>
        <span data-testid="live-size">22.8MB</span>
        <span data-testid="live-storage-badge">SQLite + JSONL</span>
      </>
    ),
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
    // Live fixture: header + 2 prompt previews + place + status + footer
    // (facts + View action).
    expect(dashboardRows).toBe(4);
    expect(liveShell.children.length).toBe(6);
  });

  it("renders prompt previews, slug·time, the data-level icon, facts and the View action for the live shape", () => {
    stubBrowserAPIs();
    const { container } = render(<SessionCard {...liveProps} />);
    expect(container.textContent).toContain("make the test deterministic");
    expect(container.textContent).toContain("also cover the retry path");
    expect(container.textContent).toContain("a9080f00 · 5m ago");
    expect(screen.getByTestId("data-level-icon")).toBeTruthy();
    expect(screen.getByTestId("live-size")).toBeTruthy();
    expect(screen.getByTestId("live-storage-badge").textContent).toBe("SQLite + JSONL");
    const viewButton = screen.getByTestId("live-view");
    expect(viewButton.textContent).toBe("View");
  });
});

/**
 * The live viewer's `LiveSessionCard` adapter: pins that a relay summary
 * produces the same shared `SessionCard` with the dashboard's rows wired up —
 * slug·time header, prompt previews, the data-level status icon, the size +
 * storage-badge facts, and the View CTA.
 */
describe("LiveSessionCard adapter", () => {
  const summary = {
    provider: "muse",
    sessionId: "a9080f00-4a4e-4f1e-9c2b-1234567890ab",
    title: "Fix the flaky test",
    project: "/home/lei/vibe-replay",
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    slug: "a9080f00",
    lineCount: 120,
    fileSize: 23986176,
    promptCount: 3,
    toolCallCount: 12,
    model: "claude-sonnet-4-20250514",
    gitRepo: "tuo-lei/vibe-replay",
    gitBranch: "feat/x",
    hasSqlite: true,
    dataSource: "sqlite",
    compactionCount: 1,
    durationMsEst: 2700000,
    editCountEst: 4,
    firstPrompts: ["make the test deterministic", "also cover the retry path"],
  };

  it("renders the shared card shell with slug·time, prompts, icon, facts and View", () => {
    stubBrowserAPIs();
    const { container } = render(<LiveSessionCard session={summary} onOpen={() => {}} />);
    const shell = container.firstElementChild!;
    // The exact shared shell: same component the dashboard renders.
    expect(shell.getAttribute("role")).toBe("button");
    expect(shell.className).toContain("bg-terminal-surface");
    expect(shell.className).toContain("rounded-xl");

    const text = container.textContent ?? "";
    expect(text).toContain("a9080f00 · ");
    expect(text).toContain("make the test deterministic");
    expect(text).toContain("also cover the retry path");
    expect(text).toContain("22.9MB");
    // Storage badge uses the dashboard's exact label…
    expect(screen.getByText("SQLite + JSONL supplement")).toBeTruthy();
    // …and the dashboard's exact badge class for the sqlite case.
    const badge = screen.getByText("SQLite + JSONL supplement");
    expect(badge.className).toContain("bg-terminal-green-subtle");
    expect(badge.className).toContain("text-terminal-green");
    // Same data-level icon component the dashboard passes as statusLeading.
    expect(screen.getByLabelText("Data level: Counted")).toBeTruthy();
    // View CTA opens the detail.
    const viewButton = screen.getByRole("button", { name: "Open Fix the flaky test" });
    expect(viewButton.textContent).toContain("View");
  });

  it("shows the JSONL transcript badge for plain JSONL sessions", () => {
    stubBrowserAPIs();
    const { container } = render(
      <LiveSessionCard
        session={{ ...summary, hasSqlite: false, dataSource: "jsonl" }}
        onOpen={() => {}}
      />,
    );
    // Same label the dashboard shows for a jsonl scan without sqlite.
    expect(screen.getByText("JSONL transcript")).toBeTruthy();
    expect(container.textContent).toContain("22.9MB");
  });

  it("still renders the fallback badge for pre-change summaries without dataSource", () => {
    stubBrowserAPIs();
    const { hasSqlite, dataSource, ...legacy } = summary;
    void hasSqlite;
    void dataSource;
    render(<LiveSessionCard session={legacy} onOpen={() => {}} />);
    // formatDataSourceLabel's fallback: honest "JSONL", not a hidden badge.
    expect(screen.getByText("JSONL")).toBeTruthy();
  });

  it("falls back to time-only when the slug is missing", () => {
    stubBrowserAPIs();
    const { container } = render(
      <LiveSessionCard session={{ ...summary, slug: undefined }} onOpen={() => {}} />,
    );
    expect(container.textContent).not.toContain(" · ");
  });

  it("truncates an overlong slug so narrow cards cannot overflow", () => {
    stubBrowserAPIs();
    const longSlug = "a".repeat(120);
    const { container } = render(
      <LiveSessionCard session={{ ...summary, slug: longSlug }} onOpen={() => {}} />,
    );
    const meta = container.querySelector('span[title="' + longSlug + '"]');
    expect(meta).toBeTruthy();
    expect(meta!.className).toContain("overflow-hidden");
    expect(meta!.className).toContain("text-ellipsis");
    expect(meta!.className).toContain("max-w-[140px]");
  });

  it("renders the branch/repo as plain text since no URLs exist remotely", () => {
    stubBrowserAPIs();
    const { container } = render(<LiveSessionCard session={summary} onOpen={() => {}} />);
    // Live passes no URLs: plain text, no anchors.
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(container.textContent).toContain("feat/x");
    expect(container.textContent).toContain("tuo-lei/vibe-replay");
  });
});
