// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textResponse, userPrompt } from "../../engine/__tests__/helpers";
import SearchOverlay from "../SearchOverlay";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Replay search navigation", () => {
  it("keeps keyboard focus inside search and restores the launcher after closing", () => {
    const launcher = document.createElement("button");
    document.body.append(launcher);
    launcher.focus();
    const onClose = vi.fn();
    const props = { scenes: [userPrompt("Hello")], onClose, onSeek: vi.fn() };
    const { rerender } = render(<SearchOverlay {...props} open />);
    const input = screen.getByRole("textbox", { name: "Search scenes" });
    const close = screen.getByRole("button", { name: "Close search" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<SearchOverlay {...props} open={false} />);
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it.each([30, 500])("finds and jumps to the matching scene in a %i-scene replay", (size) => {
    const scenes = Array.from({ length: size }, (_, i) => textResponse(`Response ${i}`));
    scenes[size - 1] = userPrompt("Find this unique target");
    const onSeek = vi.fn();
    const onClose = vi.fn();
    render(<SearchOverlay scenes={scenes} open onSeek={onSeek} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Search scenes" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "unique target" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSeek).toHaveBeenCalledWith(size - 1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not seek when Enter is pressed on the close button", () => {
    const onSeek = vi.fn();
    render(
      <SearchOverlay scenes={[userPrompt("target")]} open onSeek={onSeek} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search scenes" }), {
      target: { value: "target" },
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Close search" }), { key: "Enter" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not pass dialog keystrokes to playback shortcuts", () => {
    const playbackShortcut = vi.fn();
    window.addEventListener("keydown", playbackShortcut);
    render(
      <SearchOverlay scenes={[userPrompt("target")]} open onSeek={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Close search" }), { key: " " });
    expect(playbackShortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", playbackShortcut);
  });
});
