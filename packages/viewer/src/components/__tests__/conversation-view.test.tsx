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
    cacheCreationTokens: 300,
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

const compactionScenes: Scene[] = [
  scenes[0],
  scenes[1],
  {
    type: "compaction-summary",
    content: "Earlier work condensed.",
    timestamp: "2026-08-30T10:00:05.000Z",
  },
  {
    type: "text-response",
    content: "Continuing after compaction.",
    timestamp: "2026-08-30T10:00:06.000Z",
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
    expect(screen.getByText(/900\s+in/)).toBeTruthy();
    expect(screen.getByText(/800\s+out/)).toBeTruthy();
    expect(screen.getByText(/1\.5K\s+cache read/)).toBeTruthy();
    expect(screen.queryByText(/300\s+cache write/)).toBeNull();
    expect(screen.getByTitle(/2,700 prompt.*800 output/)).toBeTruthy();
    expect(screen.getByTitle(/300 prompt cache created.*not necessarily billable/)).toBeTruthy();
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
    expect(screen.getByText(/1\.0K\s+in/)).toBeTruthy();
    expect(screen.getByText(/1\.0K\s+out/)).toBeTruthy();
  });

  it("keeps assistant metrics separate across a compaction boundary", () => {
    render(
      <ConversationView
        scenes={compactionScenes}
        visibleCount={compactionScenes.length}
        currentIndex={3}
        effectivePrefs={prefs(false)}
        turnStats={[
          {
            turnIndex: 0,
            segmentIndex: 0,
            tokenUsage: {
              inputTokens: 100,
              outputTokens: 10,
              cacheCreationTokens: 0,
              cacheReadTokens: 50,
            },
          },
          {
            turnIndex: 0,
            segmentIndex: 1,
            tokenUsage: {
              inputTokens: 200,
              outputTokens: 20,
              cacheCreationTokens: 0,
              cacheReadTokens: 80,
            },
          },
        ]}
      />,
    );

    expect(screen.getAllByLabelText("Cumulative token usage by category")).toHaveLength(2);
    expect(screen.getByTitle(/150 prompt.*10 output/)).toBeTruthy();
    expect(screen.getByTitle(/280 prompt.*20 output/)).toBeTruthy();
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
