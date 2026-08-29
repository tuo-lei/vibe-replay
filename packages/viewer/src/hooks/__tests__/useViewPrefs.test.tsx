// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEffectivePrefs, useViewPrefs } from "../useViewPrefs";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("getEffectivePrefs", () => {
  it("returns all-visible for displayMode all", () => {
    expect(
      getEffectivePrefs({
        displayMode: "all",
        hideThinking: true,
        collapseAllTools: true,
        promptsOnly: true,
      }),
    ).toEqual({
      hideThinking: false,
      collapseAllTools: false,
      promptsOnly: false,
      compactAssistant: false,
    });
  });

  it("returns compact booleans for displayMode compact", () => {
    expect(
      getEffectivePrefs({
        displayMode: "compact",
        hideThinking: false,
        collapseAllTools: false,
        promptsOnly: false,
      }),
    ).toEqual({
      hideThinking: true,
      collapseAllTools: true,
      promptsOnly: false,
      compactAssistant: true,
    });
  });

  it("passes through custom prefs", () => {
    expect(
      getEffectivePrefs({
        displayMode: "custom",
        hideThinking: true,
        collapseAllTools: false,
        promptsOnly: true,
      }),
    ).toEqual({
      hideThinking: true,
      collapseAllTools: false,
      promptsOnly: true,
      compactAssistant: false,
    });
  });
});

describe("useViewPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("returns default compact prefs when storage empty", () => {
    const { result } = renderHook(() => useViewPrefs());
    expect(result.current.prefs.displayMode).toBe("compact");
  });

  it("migrates old prefs without displayMode to compact", () => {
    localStorage.setItem("vibe-replay-view-prefs", JSON.stringify({ hideThinking: true }));
    const { result } = renderHook(() => useViewPrefs());
    expect(result.current.prefs.displayMode).toBe("compact");
    expect(result.current.prefs.hideThinking).toBe(true);
  });

  it("loads stored prefs with displayMode", () => {
    localStorage.setItem(
      "vibe-replay-view-prefs",
      JSON.stringify({
        displayMode: "all",
        hideThinking: false,
        collapseAllTools: false,
        promptsOnly: false,
      }),
    );
    const { result } = renderHook(() => useViewPrefs());
    expect(result.current.prefs.displayMode).toBe("all");
  });

  it("falls back to default on invalid JSON", () => {
    localStorage.setItem("vibe-replay-view-prefs", "not-json!!");
    const { result } = renderHook(() => useViewPrefs());
    expect(result.current.prefs.displayMode).toBe("compact");
  });

  it("updatePref persists and updates state", () => {
    const { result } = renderHook(() => useViewPrefs());
    act(() => result.current.updatePref("displayMode", "all"));
    expect(result.current.prefs.displayMode).toBe("all");
    expect(JSON.parse(localStorage.getItem("vibe-replay-view-prefs")!).displayMode).toBe("all");
  });

  it("togglePref flips a boolean pref and persists", () => {
    localStorage.setItem(
      "vibe-replay-view-prefs",
      JSON.stringify({
        displayMode: "custom",
        hideThinking: false,
        collapseAllTools: false,
        promptsOnly: false,
      }),
    );
    const { result } = renderHook(() => useViewPrefs());
    act(() => result.current.togglePref("hideThinking"));
    expect(result.current.prefs.hideThinking).toBe(true);
    act(() => result.current.togglePref("hideThinking"));
    expect(result.current.prefs.hideThinking).toBe(false);
  });

  it("togglePref ignores non-boolean key (displayMode)", () => {
    const { result } = renderHook(() => useViewPrefs());
    const before = result.current.prefs.displayMode;
    act(() => result.current.togglePref("displayMode" as any));
    expect(result.current.prefs.displayMode).toBe(before);
  });
});
