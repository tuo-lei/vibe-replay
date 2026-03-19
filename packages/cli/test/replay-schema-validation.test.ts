import { describe, expect, it } from "vitest";

/**
 * Mirror of the Worker's validateReplaySchema function.
 * Tests here ensure the validation stays in sync with ReplaySession type.
 * If you change the ReplaySession type (packages/types), update both
 * this test and cloudflare/src/worker.ts's validateReplaySchema.
 */
function validateReplaySchema(replay: any): string | null {
  if (!replay.meta || typeof replay.meta !== "object") {
    return "Missing meta object";
  }
  if (!replay.meta.sessionId || typeof replay.meta.sessionId !== "string") {
    return "Missing meta.sessionId";
  }
  if (!replay.meta.provider || typeof replay.meta.provider !== "string") {
    return "Missing meta.provider";
  }
  if (!Array.isArray(replay.scenes)) {
    return "Missing scenes array";
  }
  for (let i = 0; i < Math.min(replay.scenes.length, 5); i++) {
    const scene = replay.scenes[i];
    if (!scene || typeof scene.type !== "string") {
      return `Invalid scene at index ${i}: missing type`;
    }
  }
  return null;
}

describe("replay schema validation", () => {
  const validReplay = {
    meta: {
      sessionId: "abc-123",
      slug: "test-session",
      provider: "claude-code",
      startTime: "2025-01-01T00:00:00Z",
      cwd: "/home/user/project",
      project: "~/project",
      stats: {
        sceneCount: 3,
        userPrompts: 1,
        toolCalls: 2,
      },
    },
    scenes: [
      { type: "user-prompt", content: "hello" },
      { type: "text-response", content: "hi there" },
      { type: "tool-call", toolName: "Read", input: {}, result: "ok" },
    ],
  };

  it("accepts a valid replay", () => {
    expect(validateReplaySchema(validReplay)).toBeNull();
  });

  it("accepts replay with empty scenes array", () => {
    expect(validateReplaySchema({ ...validReplay, scenes: [] })).toBeNull();
  });

  it("accepts replay with optional fields missing", () => {
    const minimal = {
      meta: {
        sessionId: "x",
        provider: "cursor",
        // no slug, title, startTime, cwd, project, stats — all optional for upload
      },
      scenes: [],
    };
    expect(validateReplaySchema(minimal)).toBeNull();
  });

  it("rejects missing meta", () => {
    expect(validateReplaySchema({ scenes: [] })).toBe("Missing meta object");
  });

  it("rejects meta as non-object", () => {
    expect(validateReplaySchema({ meta: "string", scenes: [] })).toBe("Missing meta object");
  });

  it("rejects missing sessionId", () => {
    const replay = { meta: { provider: "claude-code" }, scenes: [] };
    expect(validateReplaySchema(replay)).toBe("Missing meta.sessionId");
  });

  it("rejects non-string sessionId", () => {
    const replay = { meta: { sessionId: 123, provider: "claude-code" }, scenes: [] };
    expect(validateReplaySchema(replay)).toBe("Missing meta.sessionId");
  });

  it("rejects missing provider", () => {
    const replay = { meta: { sessionId: "abc" }, scenes: [] };
    expect(validateReplaySchema(replay)).toBe("Missing meta.provider");
  });

  it("rejects missing scenes", () => {
    const replay = { meta: { sessionId: "abc", provider: "claude-code" } };
    expect(validateReplaySchema(replay)).toBe("Missing scenes array");
  });

  it("rejects scenes as non-array", () => {
    const replay = { meta: { sessionId: "abc", provider: "claude-code" }, scenes: "not-array" };
    expect(validateReplaySchema(replay)).toBe("Missing scenes array");
  });

  it("rejects scene without type", () => {
    const replay = {
      meta: { sessionId: "abc", provider: "claude-code" },
      scenes: [{ content: "no type field" }],
    };
    expect(validateReplaySchema(replay)).toBe("Invalid scene at index 0: missing type");
  });

  it("rejects null scene", () => {
    const replay = {
      meta: { sessionId: "abc", provider: "claude-code" },
      scenes: [null],
    };
    expect(validateReplaySchema(replay)).toBe("Invalid scene at index 0: missing type");
  });

  it("only validates first 5 scenes (performance)", () => {
    const scenes = Array.from({ length: 10 }, (_, i) =>
      i < 6 ? { type: "text-response", content: `scene ${i}` } : { content: "no type" },
    );
    // Scene at index 6+ has no type, but validation only checks first 5
    const replay = { meta: { sessionId: "abc", provider: "claude-code" }, scenes };
    expect(validateReplaySchema(replay)).toBeNull();
  });

  it("catches invalid scene within first 5", () => {
    const scenes = [
      { type: "user-prompt", content: "ok" },
      { type: "text-response", content: "ok" },
      { content: "missing type at index 2" },
    ];
    const replay = { meta: { sessionId: "abc", provider: "claude-code" }, scenes };
    expect(validateReplaySchema(replay)).toBe("Invalid scene at index 2: missing type");
  });

  // Ensure real ReplaySession structure passes validation
  it("accepts full ReplaySession with all optional fields", () => {
    const full = {
      meta: {
        sessionId: "sess-001",
        slug: "my-session",
        title: "My Session",
        provider: "claude-code",
        dataSource: "jsonl",
        startTime: "2025-01-01T00:00:00Z",
        endTime: "2025-01-01T01:00:00Z",
        model: "claude-sonnet-4-5-20250514",
        cwd: "/home/user",
        project: "~/project",
        generator: { name: "vibe-replay", version: "0.0.14", generatedAt: "2025-01-01T00:00:00Z" },
        stats: {
          sceneCount: 2,
          userPrompts: 1,
          toolCalls: 1,
          thinkingBlocks: 0,
          durationMs: 60000,
          costEstimate: 0.5,
        },
        contextLimit: 200000,
        prLinks: [
          { prNumber: 1, prUrl: "https://github.com/org/repo/pull/1", prRepository: "org/repo" },
        ],
        compactions: [],
      },
      scenes: [
        { type: "user-prompt", content: "fix the bug", timestamp: "2025-01-01T00:00:00Z" },
        {
          type: "tool-call",
          toolName: "Edit",
          input: { file: "a.ts" },
          result: "done",
          timestamp: "2025-01-01T00:01:00Z",
        },
      ],
      annotations: [],
    };
    expect(validateReplaySchema(full)).toBeNull();
  });
});
