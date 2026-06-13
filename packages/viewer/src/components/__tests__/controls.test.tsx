// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Controls from "../Controls";

afterEach(cleanup);

function renderControls(overrides: Partial<Parameters<typeof Controls>[0]> = {}) {
  const props = {
    state: "paused" as const,
    speed: 1,
    currentIndex: 0,
    totalScenes: 5,
    userPromptCount: 2,
    currentTurn: 1,
    onTogglePlayPause: vi.fn(),
    onChangeSpeed: vi.fn(),
    onPrevPrompt: vi.fn(),
    onNextPrompt: vi.fn(),
    onOpenSearch: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<Controls {...props} />) };
}

describe("Controls", () => {
  it("renders a Play affordance when paused", () => {
    renderControls({ state: "paused" });
    expect(screen.getAllByText("Play").length).toBeGreaterThan(0);
  });

  it("renders a Pause affordance when playing", () => {
    renderControls({ state: "playing" });
    expect(screen.getAllByText("Pause").length).toBeGreaterThan(0);
  });

  it("calls onTogglePlayPause when the play/pause button is clicked", () => {
    const { props } = renderControls();
    fireEvent.click(screen.getByTitle("Play/Pause"));
    expect(props.onTogglePlayPause).toHaveBeenCalledTimes(1);
  });

  it("calls onNextPrompt / onPrevPrompt from the turn navigation buttons", () => {
    const { props } = renderControls();
    fireEvent.click(screen.getByTitle("Next turn"));
    fireEvent.click(screen.getByTitle("Previous turn"));
    expect(props.onNextPrompt).toHaveBeenCalledTimes(1);
    expect(props.onPrevPrompt).toHaveBeenCalledTimes(1);
  });

  it("opens search when the search button is clicked", () => {
    const { props } = renderControls();
    fireEvent.click(screen.getByTitle("Search"));
    expect(props.onOpenSearch).toHaveBeenCalledTimes(1);
  });
});
