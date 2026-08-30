// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene, TurnStat } from "../../types";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import type { EffectivePrefs } from "../../hooks/useViewPrefs";
import ConversationView from "../ConversationView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(stubBrowserAPIs);

const turnStat: TurnStat = {
  turnIndex: 0,
  durationMs: 4_200,
  tokenUsage: {
    inputTokens: 900,
    outputTokens: 800,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_500,
  },
};

const scenes: Scene[] = [
  {
    type: "user-prompt",
    content: "Explain this change",
    timestamp: "2026-08-30T10:00:00.000Z",
  },
  {
    type: "text-response",
    content: "Here is the explanation.",
    timestamp: "2026-08-30T10:00:04.200Z",
  },
];

function prefs(compactAssistant: boolean): EffectivePrefs {
  return {
    hideThinking: false,
    collapseAllTools: false,
    promptsOnly: false,
    compactAssistant,
  };
}

function renderConversation(compactAssistant: boolean) {
  return render(
    <ConversationView
      scenes={scenes}
      visibleCount={scenes.length}
      currentIndex={1}
      effectivePrefs={prefs(compactAssistant)}
      turnStats={[turnStat]}
    />,
  );
}

describe("ConversationView assistant metrics", () => {
  it.each([false, true])("shows duration and recorded token usage in %s mode", (compact) => {
    renderConversation(compact);

    expect(screen.getByText(/4\.2s/)).toBeTruthy();
    expect(screen.getByText(/3\.2K tok/)).toBeTruthy();
    expect(screen.getByTitle(/2,400 prompt.*800 output/)).toBeTruthy();
  });

  it("uses scene timestamps for duration when per-turn duration is unavailable", () => {
    const fallbackScenes: Scene[] = [
      scenes[0],
      {
        type: "thinking",
        content: "Thinking",
        timestamp: "2026-08-30T10:00:00.000Z",
      },
      scenes[1],
    ];
    render(
      <ConversationView
        scenes={fallbackScenes}
        visibleCount={fallbackScenes.length}
        currentIndex={1}
        effectivePrefs={prefs(false)}
        turnStats={[{ turnIndex: 0 }]}
      />,
    );

    expect(screen.getByText(/4\.2s/)).toBeTruthy();
    expect(screen.queryByText(/tok/)).toBeNull();
  });
});
