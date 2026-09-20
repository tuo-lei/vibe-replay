import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { renderLiveViewerPage } from "../src/live-viewer";

const BOX_ID = "x2KJPqQxznNNftBLSHV5jA";

function extractInlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no inline <script> found in rendered viewer page");
  return m[1];
}

describe("live viewer page", () => {
  it("renders the box id into the page", () => {
    const html = renderLiveViewerPage(BOX_ID);
    expect(html).toContain(BOX_ID);
  });

  it("escapes a hostile box id (XSS)", () => {
    const html = renderLiveViewerPage('"></script><script>alert(1)</script>');
    // The raw payload must not appear; the page must stay a single script block.
    expect(html).not.toContain('"></script><script>alert(1)</script>');
    expect(html.match(/<script>/g)?.length).toBe(1);
  });

  it("inline script parses as valid JavaScript (template-literal escape regression)", () => {
    // Regression: a single-backslash escape (e.g. "\n") inside the TS template
    // literal used to render as a literal newline, breaking the whole script
    // and leaving the viewer stuck at "Starting…".
    const js = extractInlineScript(renderLiveViewerPage(BOX_ID));
    expect(() => new Script(js)).not.toThrow();
  });
});
