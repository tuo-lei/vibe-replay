// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { textResponse, userPrompt } from "../../engine/__tests__/helpers";
import { usePlayback } from "../usePlayback";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("reveals the first scene after changing speed immediately on playback start", () => {
  vi.useFakeTimers();
  const scenes = [userPrompt("first"), textResponse("response")];
  const { result } = renderHook(() =>
    usePlayback(scenes, {
      hideThinking: false,
      collapseAllTools: false,
      promptsOnly: false,
      compactAssistant: false,
    }),
  );
  act(() => result.current.play());
  act(() => result.current.changeSpeed(5));
  act(() => vi.advanceTimersByTime(60));
  expect(result.current.speed).toBe(5);
  expect(result.current.state).toBe("playing");
  expect(result.current.currentIndex).toBe(0);
  expect(result.current.visibleCount).toBe(1);
});
