import type { ReplaySession } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import { generateGitHubGif } from "../src/formatters/gif.js";
import { buildSvgFrames, extractPhases, renderStaticFrameSvg } from "../src/formatters/github.js";

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
        toolName: "Edit",
        input: { file_path: "~/Code/my-project/src/auth.ts", old_string: "", new_string: "" },
        result: "OK",
      },
      { type: "text-response", content: "I've implemented the auth middleware." },
      { type: "user-prompt", content: "Run the tests" },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "All tests passed",
      },
    ],
    ...overrides,
  };
}

// ─── Static SVG tests ──────────────────────────────────────

describe("renderStaticFrameSvg", () => {
  it("renders a complete static SVG document", () => {
    const session = makeSession();
    const phases = extractPhases(session.scenes);
    const frames = buildSvgFrames(session, phases);
    const svg = renderStaticFrameSvg(frames[0], session);

    expect(svg).toMatch(/^<svg xmlns/);
    expect(svg).toContain("</svg>");
  });

  it("has no CSS @keyframes animation", () => {
    const session = makeSession();
    const phases = extractPhases(session.scenes);
    const frames = buildSvgFrames(session, phases);
    const svg = renderStaticFrameSvg(frames[0], session);

    expect(svg).not.toContain("@keyframes");
    expect(svg).not.toContain("animation:");
    expect(svg).not.toContain("animation-fill-mode");
  });

  it("includes frame content (label, title, etc.)", () => {
    const session = makeSession();
    const phases = extractPhases(session.scenes);
    const frames = buildSvgFrames(session, phases);
    const svg = renderStaticFrameSvg(frames[0], session);

    // Turn frames start directly (no SESSION overview)
    expect(svg).toContain("YOU");
    expect(svg).toContain("vibe-replay");
  });

  it("includes header dots and footer", () => {
    const session = makeSession();
    const phases = extractPhases(session.scenes);
    const frames = buildSvgFrames(session, phases);
    const svg = renderStaticFrameSvg(frames[0], session);

    // Header dots
    expect(svg).toContain('fill="#ff7b72"');
    expect(svg).toContain('fill="#d29922"');
    expect(svg).toContain('fill="#3fb950"');
    // Footer
    expect(svg).toContain("vibe-replay.com");
  });
});

// ─── GIF generation tests ──────────────────────────────────

describe("generateGitHubGif", () => {
  it("generates a valid GIF with correct magic bytes", async () => {
    const session = makeSession();
    const gif = await generateGitHubGif(session);

    // GIF magic bytes: "GIF89a"
    expect(gif[0]).toBe(0x47); // G
    expect(gif[1]).toBe(0x49); // I
    expect(gif[2]).toBe(0x46); // F
    expect(gif[3]).toBe(0x38); // 8
    expect(gif[4]).toBe(0x39); // 9
    expect(gif[5]).toBe(0x61); // a
  });

  it("produces reasonable file size (under 2MB)", async () => {
    const session = makeSession();
    const gif = await generateGitHubGif(session);

    // A few frames of 840-wide dark-themed SVG should be well under 2MB
    expect(gif.length).toBeGreaterThan(100);
    expect(gif.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("handles single-prompt sessions", async () => {
    const session = makeSession({
      scenes: [{ type: "user-prompt", content: "Hello" }],
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
      },
    });

    const gif = await generateGitHubGif(session);
    expect(gif[0]).toBe(0x47); // G
    expect(gif.length).toBeGreaterThan(100);
  });
}, 30_000);
