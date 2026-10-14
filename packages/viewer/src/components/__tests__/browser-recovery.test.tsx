// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import Dashboard from "../Dashboard";
import { dashboardTabParams, navigateTo } from "../dashboard-utils";
import { SearchFilterInput } from "../SessionFilters";
import Controls from "../Controls";

afterEach(() => {
  cleanup();
  window.__VIBE_REPLAY_EDITOR__ = false;
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Session browsing recovery", () => {
  const oldFilters =
    "tool=Bash&tool=Edit&mcp=github&mcpTool=github/search&skill=review&compacted=true&project=old&targetId=remote&provider=cursor&repo=old&q=old&insightsRange=7d&selected=old";

  it("clears every explorer dimension when switching tabs, then preserves filters on replay return", () => {
    window.history.replaceState({}, "", `/?view=dashboard&tab=sessions&${oldFilters}`);
    navigateTo(dashboardTabParams("replays"));
    expect(window.location.search).toBe("?view=dashboard&tab=replays");

    navigateTo({ q: "target", tool: ["Bash", "Edit"] }, { notify: false });
    navigateTo({ session: "saved-replay", view: null });
    expect(new URLSearchParams(window.location.search).has("tool")).toBe(false);
    navigateTo({ view: "dashboard", session: null });
    const restored = new URLSearchParams(window.location.search);
    expect(restored.get("tab")).toBe("replays");
    expect(restored.get("q")).toBe("target");
    expect(restored.getAll("tool")).toEqual(["Bash", "Edit"]);
  });

  it("recovers real replay results from the empty-state action", async () => {
    stubBrowserAPIs();
    window.__VIBE_REPLAY_EDITOR__ = true;
    window.history.replaceState({}, "", "/?view=dashboard&tab=replays&tool=MissingTool&q=missing");
    const sessions = [
      {
        slug: "example",
        provider: "cursor",
        project: "~/example",
        title: "Example replay",
        startTime: new Date().toISOString(),
        stats: { sceneCount: 30, userPrompts: 3, toolCalls: 1 },
        hasAnnotations: false,
        annotationCount: 0,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/archived")) return { ok: true, json: async () => ({ slugs: [] }) };
        if (url.endsWith("/api/sessions/cached"))
          return { ok: true, json: async () => ({ sessions, cachedAt: new Date().toISOString() }) };
        throw new Error("No network in test");
      }),
    );
    render(<Dashboard />);
    const clear = await screen.findByRole("button", { name: "Clear filters" });
    expect(screen.getByText("No replays match the current filters")).toBeTruthy();
    fireEvent.click(clear);
    await waitFor(() => expect(screen.getByText("Example replay")).toBeTruthy());
    expect(new URLSearchParams(window.location.search).has("tool")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false);
  });

  it("clears the query with Escape and keeps the search input focused", () => {
    const onChange = vi.fn();
    render(
      <SearchFilterInput
        value="missing"
        onChange={onChange}
        placeholder="Search…"
        ariaLabel="Search sessions"
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Clear search sessions" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(input);
  });

  it("makes playback speed available from the mobile controls", () => {
    const onChangeSpeed = vi.fn();
    render(
      <Controls
        state="paused"
        speed={1}
        currentIndex={0}
        totalScenes={500}
        currentTurn={1}
        userPromptCount={30}
        onChangeSpeed={onChangeSpeed}
        onTogglePlayPause={vi.fn()}
        onPrevPrompt={vi.fn()}
        onNextPrompt={vi.fn()}
        onOpenSearch={vi.fn()}
      />,
    );
    const mobileSpeeds = screen.getByRole("group", { name: "Playback speed" });
    expect(
      within(mobileSpeeds)
        .getByRole("button", { name: "Playback speed 1x" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(mobileSpeeds).getByRole("button", { name: "Playback speed 5x" }));
    expect(onChangeSpeed).toHaveBeenCalledWith(5);
  });
});
