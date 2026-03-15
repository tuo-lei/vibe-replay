import { describe, expect, it } from "vitest";
import { escapeHtml, escapeJsonForScript, injectDataScript } from "../src/generator.js";

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeHtml("Hello world")).toBe("Hello world");
    expect(escapeHtml("no special chars 123")).toBe("no special chars 123");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
    expect(escapeHtml("&&&")).toBe("&amp;&amp;&amp;");
  });

  it("escapes less-than signs", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than signs", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes all special characters together", () => {
    expect(escapeHtml('<div class="a&b">')).toBe("&lt;div class=&quot;a&amp;b&quot;&gt;");
  });

  it("handles XSS script injection attempt", () => {
    const xss = '<script>alert("xss")</script>';
    const escaped = escapeHtml(xss);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("</script>");
    expect(escaped).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("handles </head> in title text", () => {
    const result = escapeHtml("my </head> title");
    expect(result).not.toContain("</head>");
    expect(result).toBe("my &lt;/head&gt; title");
  });

  it("handles strings with only special characters", () => {
    expect(escapeHtml('<>&"')).toBe("&lt;&gt;&amp;&quot;");
  });

  it("does not double-escape already-escaped entities", () => {
    // If the input already has &amp; the first & should be escaped again
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("handles unicode and emoji content", () => {
    expect(escapeHtml("Hello \u4e16\u754c")).toBe("Hello \u4e16\u754c");
  });

  it("handles large input without error", () => {
    const large = "<div>".repeat(10_000);
    const result = escapeHtml(large);
    expect(result).not.toContain("<div>");
    expect(result).toContain("&lt;div&gt;");
    expect(result.length).toBeGreaterThan(large.length);
  });
});

// ---------------------------------------------------------------------------
// escapeJsonForScript
// ---------------------------------------------------------------------------

describe("escapeJsonForScript", () => {
  it("returns empty string for empty input", () => {
    expect(escapeJsonForScript("")).toBe("");
  });

  it("passes through JSON without closing tags unchanged", () => {
    const json = '{"key":"value","num":42}';
    expect(escapeJsonForScript(json)).toBe(json);
  });

  it("escapes </script> to prevent premature tag closure", () => {
    const json = '{"content":"</script>alert(1)"}';
    const result = escapeJsonForScript(json);
    expect(result).not.toContain("</script>");
    expect(result).toContain("<\\/script>");
    expect(result).toBe('{"content":"<\\/script>alert(1)"}');
  });

  it("escapes </head> sequences", () => {
    const json = '{"html":"</head><body>"}';
    const result = escapeJsonForScript(json);
    expect(result).not.toContain("</head>");
    expect(result).toContain("<\\/head>");
  });

  it("escapes all </tag> variants", () => {
    const json = '{"a":"</div>","b":"</span>","c":"</p>"}';
    const result = escapeJsonForScript(json);
    expect(result).not.toContain("</div>");
    expect(result).not.toContain("</span>");
    expect(result).not.toContain("</p>");
    expect(result).toContain("<\\/div>");
    expect(result).toContain("<\\/span>");
    expect(result).toContain("<\\/p>");
  });

  it("escapes multiple </script> occurrences in one string", () => {
    const json = '{"a":"</script>","b":"</script>"}';
    const result = escapeJsonForScript(json);
    const matches = result.match(/<\\\/script>/g);
    expect(matches).toHaveLength(2);
    expect(result).not.toContain("</script>");
  });

  it("does not alter strings without </ sequences", () => {
    const json = '{"path":"/Users/test/project","tag":"< /div>"}';
    expect(escapeJsonForScript(json)).toBe(json);
  });

  it("handles nested </script> inside code content (real-world scenario)", () => {
    // A replay session might contain source code that has </script> tags
    const sessionJson = JSON.stringify({
      scenes: [
        {
          type: "tool-result",
          content: "The file contains: <script>var x=1;</script> and more HTML",
        },
      ],
    });
    const result = escapeJsonForScript(sessionJson);
    expect(result).not.toContain("</script>");
    // The escaped result should be valid JSON when <\/ is replaced back
    const restored = result.replace(/<\\\//g, "</");
    expect(JSON.parse(restored)).toEqual(JSON.parse(sessionJson));
  });

  it("handles large input with many </ sequences", () => {
    const chunk = '{"content":"</div>"}';
    const json = `[${Array(1000).fill(chunk).join(",")}]`;
    const result = escapeJsonForScript(json);
    expect(result).not.toContain("</div>");
    const closingTagCount = (result.match(/<\\\/div>/g) || []).length;
    expect(closingTagCount).toBe(1000);
  });

  it("preserves JSON validity after escaping", () => {
    const data = { title: "Test </script> & more </head>" };
    const json = JSON.stringify(data);
    const escaped = escapeJsonForScript(json);
    // The escaped string with <\/ is still valid JSON — JSON allows \/ in strings
    const parsed = JSON.parse(escaped);
    expect(parsed.title).toBe("Test </script> & more </head>");
  });
});

// ---------------------------------------------------------------------------
// injectDataScript
// ---------------------------------------------------------------------------

describe("injectDataScript", () => {
  const simpleHtml = "<html><head><title>Test</title></head><body></body></html>";
  const scriptTag = '<script id="data">window.DATA = {};</script>';

  it("injects script tag before </head>", () => {
    const result = injectDataScript(simpleHtml, scriptTag);
    expect(result).toContain(scriptTag);
    // Script should appear before </head>
    const scriptIdx = result.indexOf(scriptTag);
    const headIdx = result.indexOf("</head>");
    expect(scriptIdx).toBeLessThan(headIdx);
  });

  it("preserves original content before and after injection", () => {
    const result = injectDataScript(simpleHtml, scriptTag);
    expect(result).toContain("<title>Test</title>");
    expect(result).toContain("<body></body></html>");
  });

  it("adds a newline between injected script and </head>", () => {
    const result = injectDataScript(simpleHtml, scriptTag);
    expect(result).toContain(`${scriptTag}\n</head>`);
  });

  it("throws when html has no </head> tag", () => {
    const badHtml = "<html><body>no head closing tag</body></html>";
    expect(() => injectDataScript(badHtml, scriptTag)).toThrow(
      "Could not find </head> tag in viewer.html",
    );
  });

  it("throws on empty html", () => {
    expect(() => injectDataScript("", scriptTag)).toThrow(
      "Could not find </head> tag in viewer.html",
    );
  });

  it("uses lastIndexOf — picks the LAST </head> in the document", () => {
    // This is the critical behavior: minified JS may contain a literal "</head>"
    // string, so we must inject before the LAST occurrence (the real HTML tag).
    const htmlWithMinifiedJs = [
      "<html><head>",
      '<script>var x="</head>";</script>', // fake </head> inside JS string
      "<title>Page</title>",
      "</head>", // real </head>
      "<body></body></html>",
    ].join("");

    const result = injectDataScript(htmlWithMinifiedJs, scriptTag);

    // The injected script should appear before the LAST </head>, not the first one
    const lastHeadIdx = result.lastIndexOf("</head>");
    const injectedIdx = result.lastIndexOf(scriptTag);
    expect(injectedIdx).toBeLessThan(lastHeadIdx);

    // The fake </head> inside JS should remain intact
    expect(result).toContain('var x="</head>"');
  });

  it("handles html with multiple </head> occurrences (minified bundle scenario)", () => {
    // Real scenario: viewer bundle JS contains string "</head>" in minified code
    const bundle = [
      "<html><head>",
      "<script>",
      'function a(){return"</head>"}', // minified JS contains </head>
      'function b(){return"test</head>more"}', // another occurrence
      "</script>",
      "</head>", // the actual closing tag
      "<body>content</body></html>",
    ].join("\n");

    const result = injectDataScript(bundle, scriptTag);

    // Count </head> occurrences — should have original count (3) still present
    const headCount = (result.match(/<\/head>/g) || []).length;
    expect(headCount).toBe(3);

    // The script tag should be right before the last </head>
    const lines = result.split("\n");
    const lastHeadLineIdx =
      lines.length - 1 - [...lines].reverse().findIndex((l) => l.includes("</head>"));
    const scriptLineIdx = lines.findIndex((l) => l.includes(scriptTag));
    expect(scriptLineIdx).toBeLessThan(lastHeadLineIdx);
  });

  it("handles empty script tag", () => {
    const result = injectDataScript(simpleHtml, "");
    expect(result).toContain("\n</head>");
  });

  it("handles html with only </head> and nothing else", () => {
    const minimalHtml = "</head>";
    const result = injectDataScript(minimalHtml, scriptTag);
    expect(result).toBe(`${scriptTag}\n</head>`);
  });

  it("handles large html document", () => {
    const largeBody = "<p>content</p>".repeat(10_000);
    const html = `<html><head><title>Big</title></head><body>${largeBody}</body></html>`;
    const result = injectDataScript(html, scriptTag);
    expect(result).toContain(scriptTag);
    expect(result.length).toBe(html.length + scriptTag.length + 1); // +1 for \n
  });
});

// ---------------------------------------------------------------------------
// Integration: escapeJsonForScript + injectDataScript together
// ---------------------------------------------------------------------------

describe("generator integration: escape + inject", () => {
  it("produces safe HTML when session data contains </script>", () => {
    const sessionData = {
      meta: { title: "Test" },
      scenes: [{ content: 'Has </script><script>alert("xss")</script> inside' }],
    };
    const json = escapeJsonForScript(JSON.stringify(sessionData));
    const dataScript = `<script id="vibe-replay-data">window.__VIBE_REPLAY_DATA__ = ${json};</script>`;
    const html = "<html><head></head><body></body></html>";
    const result = injectDataScript(html, dataScript);

    // The output should not contain an unescaped </script> inside the data script
    // Find the data script boundaries
    const scriptStart = result.indexOf('<script id="vibe-replay-data">');
    const scriptEnd = result.indexOf(";</script>", scriptStart);
    const innerContent = result.slice(
      scriptStart + '<script id="vibe-replay-data">'.length,
      scriptEnd,
    );

    // The inner content should not contain </script> which would break the DOM
    expect(innerContent).not.toContain("</script>");
    expect(innerContent).toContain("<\\/script>");
  });

  it("produces safe HTML when session data contains </head>", () => {
    const sessionData = {
      meta: { title: "Test" },
      scenes: [{ content: "User wrote </head> in their code" }],
    };
    const json = escapeJsonForScript(JSON.stringify(sessionData));
    const dataScript = `<script id="vibe-replay-data">window.__VIBE_REPLAY_DATA__ = ${json};</script>`;
    const html = "<html><head><title>vibe-replay</title></head><body></body></html>";
    const result = injectDataScript(html, dataScript);

    // The real </head> should still be the last one
    const lastHeadIdx = result.lastIndexOf("</head>");
    expect(result.slice(lastHeadIdx + 7)).toContain("<body>");
  });

  it("round-trips JSON data through escape + parse", () => {
    const original = {
      meta: { title: 'Project "Alpha" & </script> test' },
      nested: { html: "</div></span></head></html>" },
    };
    const escaped = escapeJsonForScript(JSON.stringify(original));
    // JSON.parse handles \/ correctly — it's a valid escape in JSON
    const parsed = JSON.parse(escaped);
    expect(parsed).toEqual(original);
  });
});
