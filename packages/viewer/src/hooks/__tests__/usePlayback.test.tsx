// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textResponse, thinking, userPrompt } from "../../engine/__tests__/helpers";
import type { EffectivePrefs } from "../useViewPrefs";
import { usePlayback } from "../usePlayback";

// Unmount between tests so each hook's window keydown listener is removed and
// doesn't leak into the next test.
afterEach(cleanup);

const ALL_PREFS: EffectivePrefs = {
  hideThinking: false,
  collapseAllTools: false,
  promptsOnly: false,
  compactAssistant: false,
};

const scenes = () => [
  userPrompt("first"),
  thinking(),
  textResponse(),
  userPrompt("second"),
  textResponse(),
];

describe("usePlayback", () => {
  it("starts idle with no visible scenes", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    expect(result.current.state).toBe("idle");
    expect(result.current.currentIndex).toBe(-1);
    expect(result.current.visibleCount).toBe(0);
    expect(result.current.speed).toBe(1);
    expect(result.current.totalScenes).toBe(5);
  });

  it("computes user-prompt indices", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    expect(result.current.userPromptIndices).toEqual([0, 3]);
  });

  it("seekTo sets the index, reveals up to it, and pauses from idle", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    act(() => result.current.seekTo(2));
    expect(result.current.currentIndex).toBe(2);
    expect(result.current.visibleCount).toBe(3);
    expect(result.current.state).toBe("paused");
  });

  it("seekTo clamps out-of-range indices", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    act(() => result.current.seekTo(999));
    expect(result.current.currentIndex).toBe(4);
    act(() => result.current.seekTo(-5));
    expect(result.current.currentIndex).toBe(0);
  });

  it("pause transitions to paused", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    act(() => result.current.pause());
    expect(result.current.state).toBe("paused");
  });

  it("changeSpeed updates the speed", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    act(() => result.current.changeSpeed(2));
    expect(result.current.speed).toBe(2);
  });

  it("play() is a no-op when there are no scenes", () => {
    const { result } = renderHook(() => usePlayback([], ALL_PREFS));
    act(() => result.current.play());
    expect(result.current.state).toBe("idle");
  });

  it("jumpToNextUserPrompt / jumpToPrevUserPrompt move between prompts", () => {
    const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
    act(() => result.current.jumpToNextUserPrompt());
    expect(result.current.currentIndex).toBe(0);
    act(() => result.current.jumpToNextUserPrompt());
    expect(result.current.currentIndex).toBe(3);
    act(() => result.current.jumpToPrevUserPrompt());
    expect(result.current.currentIndex).toBe(0);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("play() starts playing and reveals the first scene after the bootstrap delay", () => {
      const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
      act(() => result.current.play());
      expect(result.current.state).toBe("playing");
      expect(result.current.visibleCount).toBe(0);

      // The 50ms bootstrap reveals the first scene/batch.
      act(() => vi.advanceTimersByTime(60));
      expect(result.current.state).toBe("playing");
      expect(result.current.visibleCount).toBeGreaterThan(0);
    });

    it("reaches the ended state after the last scene, and play() restarts from the top", () => {
      const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS));
      act(() => result.current.play());
      act(() => vi.advanceTimersByTime(60)); // bootstrap

      // Fire one advancement timer at a time so React re-renders (and the
      // internal index ref updates) between steps.
      let guard = 0;
      while (result.current.state === "playing" && guard++ < 50) {
        act(() => vi.advanceTimersToNextTimer());
      }

      expect(result.current.state).toBe("ended");
      expect(result.current.currentIndex).toBe(4);
      expect(result.current.visibleCount).toBe(5);

      // play() from "ended" rewinds to the start before replaying.
      act(() => result.current.play());
      expect(result.current.state).toBe("playing");
      expect(result.current.currentIndex).toBe(-1);
    });
  });

  describe("keyboard shortcuts", () => {
    // Use fake timers so play()'s 50ms bootstrap never fires on a real clock and
    // leaks across tests.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Dispatch from a real element so the event bubbles to the window listener
    // with a DOM-element target (matching real keydown propagation).
    const press = (key: string) =>
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    it("Space toggles play/pause when enabled", () => {
      const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS, true));
      press(" ");
      expect(result.current.state).toBe("playing");
      press(" ");
      expect(result.current.state).toBe("paused");
    });

    it("ArrowDown advances to the next scene and pauses", () => {
      const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS, true));
      press("ArrowDown");
      expect(result.current.currentIndex).toBe(0);
      expect(result.current.state).toBe("paused");
    });

    it("ignores shortcuts when disabled", () => {
      const { result } = renderHook(() => usePlayback(scenes(), ALL_PREFS, false));
      press(" ");
      expect(result.current.state).toBe("idle");
    });
  });
});
