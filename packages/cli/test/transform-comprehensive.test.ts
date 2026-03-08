import { describe, expect, it } from "vitest";
import type { ProviderParseResult, TokenUsage } from "../src/providers/types.js";
import { transformToReplay } from "../src/transform.js";
import type { ParsedTurn } from "../src/types.js";

/** Build a minimal ProviderParseResult for testing */
function buildParsed(overrides: Partial<ProviderParseResult> = {}): ProviderParseResult {
  return {
    sessionId: "test-session",
    slug: "test-slug",
    cwd: "/tmp/test",
    turns: [],
    ...overrides,
  };
}

function userTurn(text: string, opts: Partial<ParsedTurn> = {}): ParsedTurn {
  return {
    role: "user",
    blocks: [{ type: "text", text }],
    ...opts,
  };
}

function assistantTextTurn(text: string, opts: Partial<ParsedTurn> = {}): ParsedTurn {
  return {
    role: "assistant",
    blocks: [{ type: "text", text }],
    ...opts,
  };
}

function assistantThinkingTurn(thinking: string, opts: Partial<ParsedTurn> = {}): ParsedTurn {
  return {
    role: "assistant",
    blocks: [{ type: "thinking", thinking }],
    ...opts,
  };
}

function assistantToolTurn(
  name: string,
  input: Record<string, any>,
  result: string,
  opts: { images?: string[] } = {},
): ParsedTurn {
  return {
    role: "assistant",
    blocks: [
      {
        type: "tool_use",
        id: `tool_${Math.random().toString(36).slice(2, 8)}`,
        name,
        input,
        _result: result,
        ...(opts.images ? { _images: opts.images } : {}),
      } as any,
    ],
  };
}

// ---------------------------------------------------------------------------
// Scene generation from turns
// ---------------------------------------------------------------------------
describe("transform — scene generation", () => {
  it("creates user-prompt scene from user turn", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [userTurn("Hello world")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].type).toBe("user-prompt");
    expect(replay.scenes[0].content).toBe("Hello world");
  });

  it("creates text-response scene from assistant text", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [assistantTextTurn("The answer is 42.")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].type).toBe("text-response");
    expect(replay.scenes[0].content).toBe("The answer is 42.");
  });

  it("creates thinking scene from assistant thinking", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [assistantThinkingTurn("Let me think...")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].type).toBe("thinking");
    expect(replay.scenes[0].content).toBe("Let me think...");
  });

  it("skips empty/whitespace-only user prompts", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [userTurn("   ")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(0);
  });

  it("skips empty/whitespace-only text responses", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [assistantTextTurn("  \n  ")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(0);
  });

  it("skips empty/whitespace-only thinking blocks", () => {
    const replay = transformToReplay(
      buildParsed({ turns: [assistantThinkingTurn("   ")] }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(0);
  });

  it("creates compaction-summary scene for compaction turns", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          userTurn("This session is being continued from previous...", {
            subtype: "compaction-summary",
          }),
        ],
      }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].type).toBe("compaction-summary");
  });

  it("handles user turn with images and text", () => {
    const turn: ParsedTurn = {
      role: "user",
      blocks: [
        { type: "text", text: "Check this screenshot" },
        { type: "_user_images", images: ["data:image/png;base64,abc123"] } as any,
      ],
    };
    const replay = transformToReplay(buildParsed({ turns: [turn] }), "claude-code", "~/test");
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].type).toBe("user-prompt");
    expect(replay.scenes[0].content).toBe("Check this screenshot");
    expect((replay.scenes[0] as any).images).toEqual(["data:image/png;base64,abc123"]);
  });

  it("creates '(image)' content for image-only user prompt", () => {
    const turn: ParsedTurn = {
      role: "user",
      blocks: [
        { type: "text", text: "" },
        { type: "_user_images", images: ["data:image/png;base64,abc123"] } as any,
      ],
    };
    const replay = transformToReplay(buildParsed({ turns: [turn] }), "claude-code", "~/test");
    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0].content).toBe("(image)");
    expect((replay.scenes[0] as any).images).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool scene enrichment
// ---------------------------------------------------------------------------
describe("transform — tool scene enrichment", () => {
  it("enriches Edit tool with diff", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn(
            "Edit",
            {
              file_path: "/tmp/test/app.ts",
              old_string: "const x = 1;",
              new_string: "const x = 2;",
            },
            "File edited.",
          ),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.diff?.filePath).toBe("/tmp/test/app.ts");
    expect(scene.type === "tool-call" && scene.diff?.oldContent).toBe("const x = 1;");
    expect(scene.type === "tool-call" && scene.diff?.newContent).toBe("const x = 2;");
  });

  it("enriches Write tool with diff (empty old)", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn(
            "Write",
            {
              file_path: "/tmp/test/new.ts",
              content: "export const foo = 1;",
            },
            "File written.",
          ),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.diff?.oldContent).toBe("");
    expect(scene.type === "tool-call" && scene.diff?.newContent).toBe("export const foo = 1;");
  });

  it("enriches Bash tool with command + stdout", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantToolTurn("Bash", { command: "ls -la" }, "total 8\ndrwxr-xr-x 2 user")],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.bashOutput?.command).toBe("ls -la");
    expect(scene.type === "tool-call" && scene.bashOutput?.stdout).toContain("total 8");
  });

  it("attaches images to tool scenes", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn("Screenshot", {}, "captured", {
            images: ["data:image/png;base64,xyz"],
          }),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.images).toEqual(["data:image/png;base64,xyz"]);
  });

  it("does not add diff/bashOutput for unknown tool names", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantToolTurn("CustomTool", { foo: "bar" }, "result data")],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.diff).toBeUndefined();
    expect(scene.type === "tool-call" && scene.bashOutput).toBeUndefined();
    expect(scene.type === "tool-call" && scene.result).toContain("result data");
  });
});

// Path redaction and secret redaction are tested in transform-security.test.ts
// (the canonical location for all redaction tests — do not duplicate here)

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------
describe("transform — truncation", () => {
  it("truncates long tool results at 5000 chars", () => {
    const longResult = "x".repeat(10000);
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantToolTurn("Read", { file_path: "/tmp/big.ts" }, longResult)],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.result.length).toBeLessThan(10000);
    expect(scene.type === "tool-call" && scene.result).toContain("truncated");
    expect(scene.type === "tool-call" && scene.result).toContain("10000 chars total");
  });

  it("truncates long tool input strings at 3000 chars", () => {
    const longContent = "y".repeat(5000);
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn("Write", { file_path: "/tmp/big.ts", content: longContent }, "ok"),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.input.content).toContain("5000 chars total");
  });

  it("truncates thinking blocks at 2000 chars", () => {
    const longThinking = "z".repeat(5000);
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantThinkingTurn(longThinking)],
      }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes[0].content.length).toBeLessThan(5000);
    expect(replay.scenes[0].content).toContain("truncated");
  });

  it("does not truncate short content", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantTextTurn("Short text")],
      }),
      "claude-code",
      "~/test",
    );
    expect(replay.scenes[0].content).toBe("Short text");
    expect(replay.scenes[0].content).not.toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------
describe("transform — input sanitization", () => {
  it("sanitizes nested objects in tool input", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn(
            "CustomTool",
            {
              config: {
                apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
              },
            },
            "ok",
          ),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    const inputStr = scene.type === "tool-call" ? JSON.stringify(scene.input) : "";
    expect(inputStr).toContain("[REDACTED]");
    expect(inputStr).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("sanitizes arrays in tool input", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          assistantToolTurn(
            "CustomTool",
            {
              tokens: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", "normal-value"],
            },
            "ok",
          ),
        ],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.input.tokens[0]).toContain("[REDACTED]");
    expect(scene.type === "tool-call" && scene.input.tokens[1]).toBe("normal-value");
  });

  it("preserves non-string values in tool input", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [assistantToolTurn("CustomTool", { count: 42, enabled: true, label: "safe" }, "ok")],
      }),
      "claude-code",
      "~/test",
    );
    const scene = replay.scenes[0];
    expect(scene.type).toBe("tool-call");
    expect(scene.type === "tool-call" && scene.input.count).toBe(42);
    expect(scene.type === "tool-call" && scene.input.enabled).toBe(true);
    expect(scene.type === "tool-call" && scene.input.label).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------
describe("transform — cost estimation", () => {
  const baseUsage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  it("applies Opus pricing by default", () => {
    const replay = transformToReplay(
      buildParsed({ model: "claude-opus-4-20250514", tokenUsage: baseUsage }),
      "claude-code",
      "~/test",
    );
    // Opus: 15 * 1M + 75 * 0.1M = 15 + 7.5 = 22.5
    expect(replay.meta.stats.costEstimate).toBeCloseTo(22.5, 1);
  });

  it("applies Sonnet pricing for sonnet model", () => {
    const replay = transformToReplay(
      buildParsed({ model: "claude-sonnet-4-20250514", tokenUsage: baseUsage }),
      "claude-code",
      "~/test",
    );
    // Sonnet: 3 * 1M + 15 * 0.1M = 3 + 1.5 = 4.5
    expect(replay.meta.stats.costEstimate).toBeCloseTo(4.5, 1);
  });

  it("applies Haiku pricing for haiku model", () => {
    const replay = transformToReplay(
      buildParsed({ model: "claude-haiku-4-20250514", tokenUsage: baseUsage }),
      "claude-code",
      "~/test",
    );
    // Haiku: 0.8 * 1M + 4 * 0.1M = 0.8 + 0.4 = 1.2
    expect(replay.meta.stats.costEstimate).toBeCloseTo(1.2, 1);
  });

  it("returns undefined cost when no token usage", () => {
    const replay = transformToReplay(
      buildParsed({ model: "claude-sonnet-4-20250514" }),
      "claude-code",
      "~/test",
    );
    expect(replay.meta.stats.costEstimate).toBeUndefined();
  });

  it("includes cache tokens in cost", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    };
    const replay = transformToReplay(
      buildParsed({ model: "claude-sonnet-4-20250514", tokenUsage: usage }),
      "claude-code",
      "~/test",
    );
    // Sonnet cache: create=3.75, read=0.3 per M
    // 3.75 + 0.3 = 4.05
    expect(replay.meta.stats.costEstimate).toBeCloseTo(4.05, 2);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
describe("transform — metadata", () => {
  it("includes all required meta fields", () => {
    const replay = transformToReplay(
      buildParsed({
        sessionId: "s1",
        slug: "sl1",
        title: "My Title",
        model: "claude-sonnet-4-20250514",
        startTime: "2025-01-01T00:00:00Z",
        endTime: "2025-01-01T01:00:00Z",
        totalDurationMs: 3600000,
        compactions: [{ timestamp: "2025-01-01T00:30:00Z", trigger: "manual" }],
      }),
      "cursor",
      "~/project",
    );
    expect(replay.meta.sessionId).toBe("s1");
    expect(replay.meta.slug).toBe("sl1");
    expect(replay.meta.title).toBe("My Title");
    expect(replay.meta.provider).toBe("cursor");
    expect(replay.meta.project).toBe("~/project");
    expect(replay.meta.model).toBe("claude-sonnet-4-20250514");
    expect(replay.meta.startTime).toBe("2025-01-01T00:00:00Z");
    expect(replay.meta.endTime).toBe("2025-01-01T01:00:00Z");
    expect(replay.meta.stats.durationMs).toBe(3600000);
    expect(replay.meta.compactions).toHaveLength(1);
  });

  it("includes generator info when provided", () => {
    const gen = {
      name: "vibe-replay",
      version: "1.0.0",
      generatedAt: "2025-01-01T00:00:00Z",
    };
    const replay = transformToReplay(buildParsed({}), "claude-code", "~/test", { generator: gen });
    expect(replay.meta.generator).toEqual(gen);
  });

  it("stats count scenes correctly", () => {
    const replay = transformToReplay(
      buildParsed({
        turns: [
          userTurn("prompt 1"),
          assistantThinkingTurn("thinking"),
          assistantTextTurn("response"),
          assistantToolTurn("Bash", { command: "ls" }, "output"),
          userTurn("prompt 2"),
        ],
      }),
      "claude-code",
      "~/test",
    );
    expect(replay.meta.stats.userPrompts).toBe(2);
    expect(replay.meta.stats.toolCalls).toBe(1);
    expect(replay.meta.stats.thinkingBlocks).toBe(1);
    expect(replay.meta.stats.sceneCount).toBe(5);
  });
});
