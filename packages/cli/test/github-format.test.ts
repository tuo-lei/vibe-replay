import type { ReplaySession, Scene } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import { generateGitHubMarkdown, generateGitHubSvg } from "../src/formatters/github.js";

// ─── Test fixtures ─────────────────────────────────────────

function makeSession(overrides?: Partial<ReplaySession>): ReplaySession {
  return {
    meta: {
      sessionId: "test-session-123",
      slug: "test-session",
      title: "Add auth middleware",
      provider: "claude-code",
      startTime: "2025-01-01T00:00:00Z",
      model: "Claude Opus",
      cwd: "~/Code/my-project",
      project: "~/Code/my-project",
      stats: {
        sceneCount: 12,
        userPrompts: 3,
        toolCalls: 8,
        thinkingBlocks: 2,
        durationMs: 720_000, // 12 min
      },
    },
    scenes: [
      { type: "user-prompt", content: "Add authentication middleware with JWT support" },
      { type: "thinking", content: "Let me analyze the codebase..." },
      {
        type: "tool-call",
        toolName: "Read",
        input: { file_path: "~/Code/my-project/src/auth.ts" },
        result: "// auth module\nexport function verify() {}",
      },
      {
        type: "tool-call",
        toolName: "Read",
        input: { file_path: "~/Code/my-project/src/routes.ts" },
        result: "// routes",
      },
      {
        type: "tool-call",
        toolName: "Edit",
        input: { file_path: "~/Code/my-project/src/auth.ts", old_string: "", new_string: "" },
        result: "OK",
      },
      {
        type: "tool-call",
        toolName: "Write",
        input: { file_path: "~/Code/my-project/src/Login.tsx", content: "" },
        result: "OK",
      },
      { type: "text-response", content: "I've implemented the auth middleware." },
      { type: "user-prompt", content: "The tests are failing, can you fix them?" },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "FAIL src/auth.test.ts\nTest Suites: 1 failed",
      },
      {
        type: "tool-call",
        toolName: "Edit",
        input: { file_path: "~/Code/my-project/src/auth.ts", old_string: "", new_string: "" },
        result: "OK",
      },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "All tests passed",
      },
      { type: "user-prompt", content: "Add rate limiting to the login endpoint" },
      {
        type: "tool-call",
        toolName: "Edit",
        input: { file_path: "~/Code/my-project/src/auth.ts", old_string: "", new_string: "" },
        result: "OK",
      },
    ],
    ...overrides,
  };
}

// ─── Markdown tests ────────────────────────────────────────

describe("generateGitHubMarkdown", () => {
  it("generates valid markdown structure", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    expect(md).toContain("### AI Coding Session");
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("vibe-replay");
  });

  it("includes session stats", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    expect(md).toContain("12 min");
    expect(md).toContain("12 steps");
    expect(md).toContain("Claude Opus");
  });

  it("shows user prompts as blockquotes", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    expect(md).toContain("> **Add authentication middleware with JWT support**");
    expect(md).toContain("> **The tests are failing, can you fix them?**");
    expect(md).toContain("> **Add rate limiting to the login endpoint**");
  });

  it("groups consecutive reads", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    // Should group the two consecutive reads into one line
    expect(md).toContain("Read `auth.ts`, `routes.ts`");
  });

  it("shows file operations", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    expect(md).toContain("Edit `auth.ts`");
    expect(md).toContain("Create `Login.tsx`");
  });

  it("shows test pass/fail", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session);

    expect(md).toContain("Run `pnpm test`");
    expect(md).toMatch(/failed/i);
    expect(md).toMatch(/passed/i);
  });

  it("includes replay URL when provided", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session, {
      replayUrl: "https://vibe-replay.com/view/?gist=abc123",
    });

    expect(md).toContain("[View full replay →](https://vibe-replay.com/view/?gist=abc123)");
  });

  it("includes SVG image when svgPath provided", () => {
    const session = makeSession();
    const md = generateGitHubMarkdown(session, {
      svgPath: "./session-preview.svg",
      replayUrl: "https://example.com",
    });

    expect(md).toContain("[![AI Session:");
    expect(md).toContain("./session-preview.svg");
    expect(md).toContain("https://example.com");
  });

  it("shows risk signals for heavily modified files", () => {
    const scenes: Scene[] = [{ type: "user-prompt", content: "Fix everything" }];
    // Add 5 edits to the same file
    for (let i = 0; i < 5; i++) {
      scenes.push({
        type: "tool-call",
        toolName: "Edit",
        input: { file_path: "~/src/app.ts", old_string: "", new_string: "" },
        result: "OK",
      });
    }

    const session = makeSession({
      scenes,
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 6, userPrompts: 1, toolCalls: 5 },
      },
    });

    const md = generateGitHubMarkdown(session);
    expect(md).toContain("`app.ts` modified 5x");
  });

  it("handles empty sessions gracefully", () => {
    const session = makeSession({
      scenes: [],
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 },
      },
    });

    const md = generateGitHubMarkdown(session);
    expect(md).toContain("### AI Coding Session");
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
  });

  it("truncates long user prompts", () => {
    const longPrompt = "A".repeat(200);
    const session = makeSession({
      scenes: [{ type: "user-prompt", content: longPrompt }],
    });

    const md = generateGitHubMarkdown(session);
    // Should be truncated with ellipsis
    expect(md.length).toBeLessThan(longPrompt.length + 500);
  });
});

// ─── SVG tests ─────────────────────────────────────────────

describe("generateGitHubSvg", () => {
  it("generates valid SVG", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toMatch(/^<svg xmlns/);
    expect(svg).toContain("</svg>");
  });

  it("includes CSS animation keyframes", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toContain("@keyframes fadeInOut");
    expect(svg).toContain("animation:");
  });

  it("includes terminal-style header with dots", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    // Three window control dots
    expect(svg).toMatch(/<circle.*fill="#ff7b72"/);
    expect(svg).toMatch(/<circle.*fill="#d29922"/);
    expect(svg).toMatch(/<circle.*fill="#3fb950"/);
  });

  it("includes vibe-replay branding", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toContain("vibe-replay");
    expect(svg).toContain("vibe-replay.com");
  });

  it("shows task description", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toContain("Add authentication middleware with JWT support");
  });

  it("has multiple animated frames", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    // Should have frame-0 through at least frame-2 (title + phases + summary)
    expect(svg).toContain('class="frame frame-0"');
    expect(svg).toContain('class="frame frame-1"');
  });

  it("includes frame labels", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toContain("TASK");
    expect(svg).toContain("COMPLETE");
  });

  it("escapes XML special characters", () => {
    const session = makeSession({
      scenes: [{ type: "user-prompt", content: "Fix the <div> & <span> tags" }],
    });

    const svg = generateGitHubSvg(session);

    expect(svg).not.toContain("<div>");
    expect(svg).toContain("&lt;div&gt;");
    expect(svg).toContain("&amp;");
  });

  it("shows step count and COMPLETE frame", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    expect(svg).toContain("COMPLETE");
    expect(svg).toContain("12 steps");
  });

  it("has reasonable file size", () => {
    const session = makeSession();
    const svg = generateGitHubSvg(session);

    // SVG should be under 50KB for GitHub rendering
    expect(svg.length).toBeLessThan(50_000);
  });
});
