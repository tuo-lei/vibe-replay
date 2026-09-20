import { describe, expect, it } from "vitest";
import { renderLiveViewerPage } from "../src/live-viewer";

describe("live viewer shell page", () => {
  it("bootstraps the React live viewer bundle", () => {
    const html = renderLiveViewerPage("test-version");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/live-app/live.js?v=test-version">');
    expect(html).toContain('<link rel="stylesheet" href="/live-app/live.css?v=test-version" />');
  });

  it("has no inline script — nothing to inject, no XSS surface", () => {
    // The app reads the box id from location.pathname and the key from the
    // URL fragment, so the shell carries zero dynamic script content.
    // (The previous hand-rolled page embedded BOX_ID in inline JS; the
    // escaping there once broke the whole page — see git history.)
    const html = renderLiveViewerPage("v1");
    const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
    expect(inlineScripts).toEqual([]);
  });

  it("cache-busts safely with an unusual version id", () => {
    const html = renderLiveViewerPage('"><script>alert(1)</script>');
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain("?v=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  });
});
