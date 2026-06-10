import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  hasHtmlTextHighlights,
  injectHtmlTextHighlights,
  injectMarkdownHighlights,
} from "./annotation-highlights";

class TestDOMParser {
  parseFromString(html: string): Document {
    return parseHTML(`<!doctype html><html><body>${html}</body></html>`)
      .document as unknown as Document;
  }
}

globalThis.DOMParser = TestDOMParser as unknown as typeof globalThis.DOMParser;
globalThis.Node = parseHTML("<html><body></body></html>").Node as typeof globalThis.Node;

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

  it("escapes annotation ids in markdown highlight attributes", () => {
    const output = injectMarkdownHighlights("hello annotated world", [
      {
        id: 'annotation-" onclick="bad',
        text: "annotated",
        title: "comment",
      },
    ]);

    expect(output).toContain('data-vibe-annotation-id="annotation-&quot; onclick=&quot;bad"');
  });

  it("highlights rendered HTML text across multiple text nodes", () => {
    const output = injectHtmlTextHighlights("<p>Hello <strong>annotated</strong> world</p>", [
      {
        id: "annotation-1",
        text: "Hello annotated world",
        title: "comment",
      },
    ]);

    expect(output).toContain('data-vibe-annotation-id="annotation-1"');
    expect(output).toContain("<strong>");
    expect(output).toContain("</strong>");
  });

  it("checks rendered HTML text rather than markdown source text", () => {
    const highlights = [
      {
        id: "annotation-1",
        text: "**annotated**",
        title: "comment",
      },
    ];

    expect(hasHtmlTextHighlights("<p><strong>annotated</strong></p>", highlights)).toBe(false);
  });
});
