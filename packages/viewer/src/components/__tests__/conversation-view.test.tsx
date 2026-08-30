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

const multiTurnScenes: Scene[] = [
  ...scenes,
  {
    type: "context-injection",
    content: "A skill was loaded",
    timestamp: "2026-08-30T10:00:05.000Z",
    injectionType: "skill:demo",
  },
  {
    type: "user-prompt",
    content: "Now apply it",
    timestamp: "2026-08-30T10:00:06.000Z",
  },
  {
    type: "text-response",
    content: "Applied.",
    timestamp: "2026-08-30T10:00:08.000Z",
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

  it("matches metrics to each real turn across context injections", () => {
    render(
      <ConversationView
        scenes={multiTurnScenes}
        visibleCount={multiTurnScenes.length}
        currentIndex={4}
        effectivePrefs={prefs(false)}
        turnStats={[
          turnStat,
          {
            turnIndex: 1,
            durationMs: 8_100,
            tokenUsage: {
              inputTokens: 1_000,
              outputTokens: 1_000,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText(/4\.2s/)).toBeTruthy();
    expect(screen.getByText(/8\.1s/)).toBeTruthy();
    expect(screen.getByText(/2\.0K tok/)).toBeTruthy();
  });

  it("does not fall back by position for sparse indexed stats", () => {
    render(
      <ConversationView
        scenes={multiTurnScenes}
        visibleCount={multiTurnScenes.length}
        currentIndex={4}
        effectivePrefs={prefs(false)}
        turnStats={[{ turnIndex: 1, durationMs: 2_200 }]}
      />,
    );

    expect(screen.getByText(/2\.2s/)).toBeTruthy();
    expect(screen.queryByText(/tok/)).toBeNull();
  });
});
