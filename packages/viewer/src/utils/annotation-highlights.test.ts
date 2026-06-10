import { describe, expect, it } from "vitest";
import { injectMarkdownHighlights } from "./annotation-highlights";

describe("annotation highlights", () => {
  it("uses source ranges before selected-text fallback", () => {
    const content = "repeat once, repeat twice";
    const output = injectMarkdownHighlights(content, [
      {
        id: "annotation-1",
        text: "repeat",
        title: "comment",
        start: 13,
        end: 19,
      },
    ]);

    expect(output).toContain('repeat once, <mark data-vibe-annotation-id="annotation-1"');
  });

  it("falls back to selected text when a range is stale", () => {
    const output = injectMarkdownHighlights("hello annotated world", [
      {
        id: "annotation-1",
        text: "annotated",
        title: "comment",
        start: 0,
        end: 5,
      },
    ]);

    expect(output).toContain('hello <mark data-vibe-annotation-id="annotation-1"');
  });
});
