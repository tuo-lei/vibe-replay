// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../../types";
import { textResponse, thinking, userPrompt } from "../../engine/__tests__/helpers";
import type { ViewPrefs } from "../../hooks/useViewPrefs";
import Player from "../Player";

// jsdom doesn't implement these browser APIs; Player uses them from effects.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", StubObserver);
  vi.stubGlobal("ResizeObserver", StubObserver);
});

afterEach(cleanup);

const VIEW_PREFS: ViewPrefs = {
  displayMode: "all",
  hideThinking: false,
  collapseAllTools: false,
  promptsOnly: false,
};

function makeSession(): ReplaySession {
  const scenes = [userPrompt("first"), thinking(), textResponse(), userPrompt("second")];
  return {
    meta: {
      sessionId: "s1",
      slug: "test-session",
      provider: "claude-code",
      startTime: "2025-01-01T00:00:00Z",
      cwd: "~/Code/x",
      project: "~/Code/x",
      stats: { sceneCount: scenes.length, userPrompts: 2, toolCalls: 0 },
    },
    scenes,
  } as unknown as ReplaySession;
}

describe("Player (smoke)", () => {
  it("mounts a session and shows the landing screen first", () => {
    render(
      <Player
        session={makeSession()}
        viewPrefs={VIEW_PREFS}
        activeView="replay"
        setActiveView={vi.fn()}
      />,
    );
    // Player opens on the landing hero, not the playback chrome.
    expect(screen.getAllByText(/Watch Replay/i).length).toBeGreaterThan(0);
    expect(screen.queryByTitle(/^Play\/Pause/)).toBeNull();
  });

  it("reveals the playback controls after entering the replay", () => {
    render(
      <Player
        session={makeSession()}
        viewPrefs={VIEW_PREFS}
        activeView="replay"
        setActiveView={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByText(/Watch Replay/i)[0]);
    // The Controls play/pause button is a stable signal the player chrome rendered.
    expect(screen.getAllByTitle(/^Play\/Pause/).length).toBeGreaterThan(0);
  });

  it("renders an empty session without crashing", () => {
    const empty = {
      meta: { ...makeSession().meta, stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 } },
      scenes: [],
    } as unknown as ReplaySession;
    expect(() =>
      render(
        <Player
          session={empty}
          viewPrefs={VIEW_PREFS}
          activeView="replay"
          setActiveView={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });
});
