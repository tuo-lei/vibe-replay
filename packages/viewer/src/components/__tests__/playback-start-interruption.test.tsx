// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { userPrompt, textResponse } from "../../engine/__tests__/helpers";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import type { ReplaySession } from "../../types";
import Player from "../Player";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("honors Pause immediately after Watch Replay without starting again later", () => {
  stubBrowserAPIs();
  vi.useFakeTimers();
  const scenes = [userPrompt("Build an example"), textResponse("Example response")];
  const session = {
    meta: {
      sessionId: "example",
      slug: "example",
      provider: "codex",
      project: "/example",
      cwd: "/example",
      startTime: "2026-10-10T00:00:00Z",
      stats: { sceneCount: 2, userPrompts: 1, toolCalls: 0 },
    },
    scenes,
  } as ReplaySession;
  render(
    <Player
      session={session}
      activeView="replay"
      setActiveView={vi.fn()}
      viewPrefs={{
        displayMode: "all",
        hideThinking: false,
        collapseAllTools: false,
        promptsOnly: false,
      }}
    />,
  );
  fireEvent.click(screen.getAllByText(/Watch Replay/i)[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(2);
});
