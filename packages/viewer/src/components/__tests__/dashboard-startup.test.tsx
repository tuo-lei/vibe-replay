// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardStartup } from "../DashboardStartup";

const props = {
  progress: null,
  loading: true,
  loadingSources: true,
  sources: [],
  replayCount: 0,
  error: null,
  failures: [],
  onRetry: vi.fn(),
  onContinue: vi.fn(),
};
afterEach(cleanup);
describe("DashboardStartup", () => {
  it("uses indeterminate progress until the catalog total is known", () => {
    render(
      <DashboardStartup
        {...props}
        progress={{
          type: "progress",
          phase: "discovering",
          scanned: 27,
          providers: ["codex"],
          previews: [],
        }}
      />,
    );
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(screen.getByText("27 session records found")).toBeTruthy();
    expect(screen.queryByText("0 sessions")).toBeNull();
  });
  it("shows real titles and actual preparation counts", () => {
    render(
      <DashboardStartup
        {...props}
        progress={{
          type: "progress",
          phase: "preparing",
          scanned: 40,
          prepared: 8,
          total: 30,
          providers: ["codex"],
          previews: [
            {
              provider: "codex",
              slug: "abc",
              project: "~/vibe-replay",
              timestamp: "",
              title: "Fix keyboard navigation",
              firstPrompt: "prompt",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Fix keyboard navigation")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("8");
    expect(screen.getByRole("progressbar").getAttribute("max")).toBe("30");
  });
  it("lets users access saved replays when source discovery fails", () => {
    render(
      <DashboardStartup
        {...props}
        loading={false}
        loadingSources={false}
        failures={["Cursor"]}
        replayCount={2}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("2 saved replays are available.");
    fireEvent.click(screen.getByRole("button", { name: "Continue with saved replays" }));
    expect(props.onContinue).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("stops progress on failures and exposes retry", () => {
    render(<DashboardStartup {...props} loading={false} error="Discovery failed" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Discovery failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
  });
});

it("shows detected provider icons and reading states before any session is available", () => {
  render(
    <DashboardStartup
      {...props}
      progress={{
        type: "progress",
        phase: "discovering",
        scanned: 0,
        providers: ["codex", "pi"],
        previews: [],
        providerStates: [
          { provider: "codex", detected: true, status: "reading" },
          { provider: "pi", detected: true, status: "found" },
          { provider: "cursor", detected: false, status: "empty", sessionCount: 0 },
        ],
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Found 2 session sources" })).toBeTruthy();
  expect(screen.getByText("Codex")).toBeTruthy();
  expect(screen.getByText("Pi")).toBeTruthy();
  expect(screen.queryByText("Cursor")).toBeNull();
  expect(screen.getByText("Reading Codex sessions…")).toBeTruthy();
  expect(screen.getByText("0 / 2 sources read")).toBeTruthy();
  expect(screen.getByText("vibe-replay")).toBeTruthy();
  expect(screen.getByText("Replay the work. Discover the patterns.")).toBeTruthy();
});

it("does not count an unavailable source as successfully read", () => {
  render(
    <DashboardStartup
      {...props}
      progress={{
        type: "progress",
        phase: "discovering",
        scanned: 0,
        providers: ["cursor", "pi"],
        previews: [],
        providerStates: [
          { provider: "cursor", detected: true, status: "failed", sessionCount: 0 },
          { provider: "pi", detected: true, status: "reading" },
        ],
      }}
    />,
  );
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.getByText("0 / 2 sources read")).toBeTruthy();
});

it("stops provider reading feedback when discovery ends with a stream error", () => {
  render(
    <DashboardStartup
      {...props}
      loading={false}
      loadingSources={false}
      error="Discovery interrupted"
      progress={{
        type: "progress",
        phase: "discovering",
        scanned: 0,
        providers: ["codex"],
        previews: [],
        providerStates: [{ provider: "codex", detected: true, status: "reading" }],
      }}
    />,
  );
  expect(screen.getByText("Not finished")).toBeTruthy();
  expect(screen.queryByText("Reading…")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(document.querySelector(".dashboard-startup-provider.is-reading")).toBeNull();
});

it("prefers current discovery previews over a cached session during refresh", () => {
  const cached = {
    provider: "codex",
    slug: "cached",
    project: "~/project",
    timestamp: "",
    firstPrompt: "Old cached session",
    title: "Old cached session",
    fileSize: 0,
    lineCount: 0,
    filePaths: [],
    existingReplay: null,
  };
  render(
    <DashboardStartup
      {...props}
      sources={[cached]}
      progress={{
        type: "progress",
        phase: "discovering",
        scanned: 1,
        providers: ["codex"],
        previews: [{ ...cached, slug: "new", title: "Newly discovered session" }],
      }}
    />,
  );
  expect(screen.getByText("Newly discovered session")).toBeTruthy();
  expect(screen.queryByText("Old cached session")).toBeNull();
});

it("describes concurrent reads without suggesting one provider is being read at a time", () => {
  render(
    <DashboardStartup
      {...props}
      progress={{
        type: "progress",
        phase: "discovering",
        scanned: 30,
        providers: ["codex", "pi", "cursor"],
        previews: [],
        providerStates: [
          { provider: "codex", detected: true, status: "reading" },
          { provider: "pi", detected: true, status: "reading" },
          { provider: "cursor", detected: true, status: "ready", sessionCount: 30 },
        ],
      }}
    />,
  );
  expect(screen.getByText("Reading sessions from 2 sources…")).toBeTruthy();
  expect(screen.getAllByText("Reading…")).toHaveLength(2);
  expect(screen.getByText("1 / 3 sources read")).toBeTruthy();
});
