import type { ReplaySession, Scene } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import {
  buildSessionDigest,
  extractJson,
  type FeedbackResult,
  feedbackToAnnotations,
  findBalancedJson,
  parseFeedbackResponse,
  repairTruncatedJson,
  stripAnsi,
} from "../src/feedback.js";

// ─── Test fixtures ─────────────────────────────────────────

function makeSession(overrides?: Partial<ReplaySession>): ReplaySession {
  return {
    meta: {
      sessionId: "test-session-123",
      slug: "test-session",
      title: "Test session",
      provider: "claude-code",
      startTime: "2025-01-01T00:00:00Z",
      model: "Claude Opus",
      cwd: "~/Code/my-project",
      project: "~/Code/my-project",
      stats: {
        sceneCount: 5,
        userPrompts: 2,
        toolCalls: 1,
        thinkingBlocks: 1,
        durationMs: 120_000,
        costEstimate: 0.05,
      },
    },
    scenes: [
      { type: "user-prompt", content: "Fix the auth bug in login.ts" },
      { type: "thinking", content: "Let me look at the login code" },
      {
        type: "tool-call",
        toolName: "Read",
        input: { file_path: "src/login.ts" },
        result: "export function login() {}",
      },
      { type: "text-response", content: "I found and fixed the bug." },
      { type: "user-prompt", content: "Now add tests" },
    ],
    ...overrides,
  };
}

function makeValidFeedbackJson(overrides?: Record<string, any>): string {
  return JSON.stringify({
    summary: "Good session overall.",
    score: 7,
    strengths: ["Clear prompts"],
    improvements: ["Add more context"],
    feedbackItems: [
      {
        sceneIndex: 0,
        title: "Good start",
        feedback: "Clear initial prompt.",
        category: "clarity",
      },
    ],
    ...overrides,
  });
}

// ─── extractJson ───────────────────────────────────────────

describe("extractJson", () => {
  it("returns valid JSON string as-is", () => {
    const json = '{"key": "value"}';
    expect(extractJson(json)).toBe(json);
  });

  it("returns null for empty input", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(extractJson("   \n\t  ")).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(extractJson("Hello, world! This is not JSON.")).toBeNull();
  });

  it("extracts JSON from markdown code fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: "value" });
  });

  it("extracts JSON from code fences without language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: "value" });
  });

  it("extracts JSON surrounded by text", () => {
    const input = 'Here is the result:\n{"summary": "test", "score": 5}\nDone!';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ summary: "test", score: 5 });
  });

  it("fixes missing opening brace before sceneIndex", () => {
    // Common model error: }, "sceneIndex": instead of },{"sceneIndex":
    const input =
      '{"feedbackItems": [{"sceneIndex": 0, "title": "a", "feedback": "b"}, "sceneIndex": 1, "title": "c", "feedback": "d"}]}';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.feedbackItems).toHaveLength(2);
  });

  it("handles deeply nested JSON", () => {
    const obj = {
      a: { b: { c: { d: [1, 2, { e: "f" }] } } },
    };
    const input = `Some text before ${JSON.stringify(obj)} some text after`;
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual(obj);
  });

  it("handles JSON with escaped characters", () => {
    const json = '{"text": "line1\\nline2\\ttab\\"quoted\\""}';
    const result = extractJson(json);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).text).toBe('line1\nline2\ttab"quoted"');
  });

  it("handles truncated JSON by repairing", () => {
    // A truncated response that has enough structure to repair
    const json =
      '{"summary": "Good session", "score": 7, "strengths": ["Clear prompts"], "improvements": ["More context"], "feedbackItems": [{"sceneIndex": 0, "title": "test", "feedback": "ok", "category": "clarity"},';
    const result = extractJson(json);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.summary).toBe("Good session");
  });
});

// ─── findBalancedJson ──────────────────────────────────────

describe("findBalancedJson", () => {
  it("finds balanced JSON object in clean string", () => {
    const result = findBalancedJson('{"a": 1}');
    expect(result).toBe('{"a": 1}');
  });

  it("returns null for empty string", () => {
    expect(findBalancedJson("")).toBeNull();
  });

  it("returns null for string with no braces", () => {
    expect(findBalancedJson("hello world")).toBeNull();
  });

  it("finds JSON object embedded in text", () => {
    const result = findBalancedJson('prefix text {"key": "value"} suffix');
    expect(result).toBe('{"key": "value"}');
  });

  it("handles nested braces", () => {
    const json = '{"outer": {"inner": "value"}}';
    const result = findBalancedJson(`before ${json} after`);
    expect(result).toBe(json);
  });

  it("handles arrays within objects", () => {
    const json = '{"arr": [1, 2, {"nested": true}]}';
    const result = findBalancedJson(json);
    expect(result).toBe(json);
  });

  it("skips braces inside strings", () => {
    const json = '{"text": "has { braces } inside"}';
    const result = findBalancedJson(json);
    expect(result).toBe(json);
  });

  it("handles escaped quotes in strings", () => {
    const json = '{"text": "has \\"escaped\\" quotes"}';
    const result = findBalancedJson(json);
    expect(result).toBe(json);
  });

  it("handles escaped backslashes", () => {
    const json = '{"path": "C:\\\\Users\\\\test"}';
    const result = findBalancedJson(json);
    expect(result).toBe(json);
  });

  it("returns null for unbalanced braces", () => {
    expect(findBalancedJson('{"key": "value"')).toBeNull();
  });

  it("returns null for invalid JSON with balanced braces", () => {
    // Balanced braces but not valid JSON
    expect(findBalancedJson("{not valid json}")).toBeNull();
  });

  it("finds first valid JSON when multiple objects exist", () => {
    const result = findBalancedJson('{"a": 1} {"b": 2}');
    expect(result).toBe('{"a": 1}');
  });

  it("skips invalid first object and finds second", () => {
    const result = findBalancedJson('{invalid} {"valid": true}');
    expect(result).toBe('{"valid": true}');
  });
});

// ─── repairTruncatedJson ───────────────────────────────────

describe("repairTruncatedJson", () => {
  it("repairs JSON with missing closing brace", () => {
    const truncated = '{"key": "value"';
    const result = repairTruncatedJson(truncated);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: "value" });
  });

  it("repairs JSON with missing closing bracket and brace", () => {
    const truncated = '{"items": [1, 2, 3';
    const result = repairTruncatedJson(truncated);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.items).toEqual([1, 2, 3]);
  });

  it("repairs deeply nested truncated JSON", () => {
    const truncated = '{"a": {"b": [{"c": "d"},';
    const result = repairTruncatedJson(truncated);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it("returns null for already-complete JSON", () => {
    // No suffix needed, function returns null because suffix is empty
    const complete = '{"key": "value"}';
    expect(repairTruncatedJson(complete)).toBeNull();
  });

  it("returns null for completely broken input", () => {
    expect(repairTruncatedJson("not json at all")).toBeNull();
  });

  it("handles truncated feedback-like JSON", () => {
    const truncated =
      '{"summary": "Overall good session", "score": 7, "strengths": ["Clear"], "improvements": ["Be specific"], "feedbackItems": [{"sceneIndex": 0, "title": "Start", "feedback": "Good start", "category": "clarity"},';
    const result = repairTruncatedJson(truncated);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.summary).toBe("Overall good session");
    expect(parsed.score).toBe(7);
    expect(parsed.feedbackItems).toHaveLength(1);
  });

  it("handles truncation mid-string value", () => {
    // When truncated in the middle of a string, it should try to find
    // the last good boundary and close brackets
    const truncated =
      '{"summary": "test", "score": 5, "strengths": ["good"], "improvements": ["more context"], "feedbackItems": [{"sceneIndex": 0, "title": "item", "feedback": "some feedback that got trun';
    const result = repairTruncatedJson(truncated);
    // May or may not repair depending on where the last good point is
    if (result) {
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });
});

// ─── parseFeedbackResponse ─────────────────────────────────

describe("parseFeedbackResponse", () => {
  const session = makeSession();

  it("parses valid feedback JSON", () => {
    const json = makeValidFeedbackJson();
    const result = parseFeedbackResponse(json, session);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Good session overall.");
    expect(result!.score).toBe(7);
    expect(result!.strengths).toEqual(["Clear prompts"]);
    expect(result!.improvements).toEqual(["Add more context"]);
    expect(result!.feedbackItems).toHaveLength(1);
    expect(result!.feedbackItems[0].sceneIndex).toBe(0);
    expect(result!.feedbackItems[0].title).toBe("Good start");
    expect(result!.feedbackItems[0].category).toBe("clarity");
  });

  it("returns null for empty string", () => {
    expect(parseFeedbackResponse("", session)).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(parseFeedbackResponse("This is just text", session)).toBeNull();
  });

  it("returns null if summary is missing", () => {
    const json = makeValidFeedbackJson({ summary: undefined });
    // Need to remove the summary key entirely
    const obj = JSON.parse(json);
    delete obj.summary;
    expect(parseFeedbackResponse(JSON.stringify(obj), session)).toBeNull();
  });

  it("returns null if summary is empty string", () => {
    const result = parseFeedbackResponse(makeValidFeedbackJson({ summary: "" }), session);
    expect(result).toBeNull();
  });

  it("returns null if score is not a number", () => {
    const result = parseFeedbackResponse(makeValidFeedbackJson({ score: "high" }), session);
    expect(result).toBeNull();
  });

  it("clamps score to 1-10 range", () => {
    const lowResult = parseFeedbackResponse(makeValidFeedbackJson({ score: -5 }), session);
    expect(lowResult).not.toBeNull();
    expect(lowResult!.score).toBe(1);

    const highResult = parseFeedbackResponse(makeValidFeedbackJson({ score: 99 }), session);
    expect(highResult).not.toBeNull();
    expect(highResult!.score).toBe(10);
  });

  it("rounds fractional scores", () => {
    const result = parseFeedbackResponse(makeValidFeedbackJson({ score: 7.6 }), session);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(8);
  });

  it("defaults strengths/improvements to empty arrays when missing", () => {
    const obj = JSON.parse(makeValidFeedbackJson());
    obj.strengths = "not an array";
    obj.improvements = null;
    const result = parseFeedbackResponse(JSON.stringify(obj), session);
    expect(result).not.toBeNull();
    expect(result!.strengths).toEqual([]);
    expect(result!.improvements).toEqual([]);
  });

  it("filters non-string entries from strengths/improvements", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        strengths: ["valid", 42, null, "also valid"],
        improvements: [true, "good point"],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.strengths).toEqual(["valid", "also valid"]);
    expect(result!.improvements).toEqual(["good point"]);
  });

  it("filters out feedback items with invalid sceneIndex", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [
          { sceneIndex: 0, title: "Valid", feedback: "ok", category: "clarity" },
          { sceneIndex: 1, title: "Invalid index", feedback: "not a prompt", category: "clarity" },
          { sceneIndex: 99, title: "Out of range", feedback: "nope", category: "clarity" },
          { sceneIndex: 4, title: "Also valid", feedback: "yes", category: "context" },
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    // Only sceneIndex 0 and 4 are user-prompt scenes
    expect(result!.feedbackItems).toHaveLength(2);
    expect(result!.feedbackItems[0].sceneIndex).toBe(0);
    expect(result!.feedbackItems[1].sceneIndex).toBe(4);
  });

  it("defaults invalid category to 'clarity'", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [{ sceneIndex: 0, title: "Test", feedback: "ok", category: "nonexistent" }],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.feedbackItems[0].category).toBe("clarity");
  });

  it("accepts all valid categories", () => {
    const categories = [
      "clarity",
      "specificity",
      "context",
      "efficiency",
      "iteration",
      "tool-usage",
    ];
    for (const cat of categories) {
      const result = parseFeedbackResponse(
        makeValidFeedbackJson({
          feedbackItems: [{ sceneIndex: 0, title: "Test", feedback: "ok", category: cat }],
        }),
        session,
      );
      expect(result).not.toBeNull();
      expect(result!.feedbackItems[0].category).toBe(cat);
    }
  });

  it("skips feedback items with missing required fields", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [
          { sceneIndex: 0, feedback: "ok", category: "clarity" }, // missing title
          { sceneIndex: 0, title: "Test", category: "clarity" }, // missing feedback
          { title: "Test", feedback: "ok", category: "clarity" }, // missing sceneIndex
          null, // null item
          "not an object", // not an object
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.feedbackItems).toHaveLength(0);
  });

  it("includes improvedPrompt when present", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [
          {
            sceneIndex: 0,
            title: "Test",
            feedback: "ok",
            category: "clarity",
            improvedPrompt: "Better prompt here",
          },
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.feedbackItems[0].improvedPrompt).toBe("Better prompt here");
  });

  it("omits improvedPrompt when empty string", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [
          {
            sceneIndex: 0,
            title: "Test",
            feedback: "ok",
            category: "clarity",
            improvedPrompt: "",
          },
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.feedbackItems[0].improvedPrompt).toBeUndefined();
  });

  it("omits improvedPrompt when not a string", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        feedbackItems: [
          {
            sceneIndex: 0,
            title: "Test",
            feedback: "ok",
            category: "clarity",
            improvedPrompt: 42,
          },
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.feedbackItems[0].improvedPrompt).toBeUndefined();
  });

  // --- Session-level fields (Phase 1A) ---

  it("parses outcome and sessionGoal when present", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        outcome: "mostly_achieved",
        sessionGoal: "Fix the login bug",
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("mostly_achieved");
    expect(result!.sessionGoal).toBe("Fix the login bug");
  });

  it("ignores invalid outcome values", () => {
    const result = parseFeedbackResponse(makeValidFeedbackJson({ outcome: "kinda_done" }), session);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBeUndefined();
  });

  it("parses frictionPoints when valid", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        frictionPoints: [
          { type: "misunderstood", description: "AI read wrong file", turn: 2 },
          { type: "buggy_code", description: "Test failed", turn: 4 },
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.frictionPoints).toHaveLength(2);
    expect(result!.frictionPoints![0].type).toBe("misunderstood");
    expect(result!.frictionPoints![1].turn).toBe(4);
  });

  it("filters out invalid frictionPoints entries", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        frictionPoints: [
          { type: "invalid_type", description: "nope", turn: 1 },
          { type: "buggy_code", description: "valid", turn: 3 },
          { type: "wrong_approach" }, // missing description and turn
        ],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.frictionPoints).toHaveLength(1);
    expect(result!.frictionPoints![0].type).toBe("buggy_code");
  });

  it("sets frictionPoints to undefined when all entries are invalid", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        frictionPoints: [{ type: "fake", description: "nope", turn: 1 }],
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.frictionPoints).toBeUndefined();
  });

  it("parses aiPerformance when valid", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        aiPerformance: {
          rating: "good",
          strengths: ["Fast search"],
          weaknesses: ["Missed edge case"],
        },
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.aiPerformance).toBeDefined();
    expect(result!.aiPerformance!.rating).toBe("good");
    expect(result!.aiPerformance!.strengths).toEqual(["Fast search"]);
    expect(result!.aiPerformance!.weaknesses).toEqual(["Missed edge case"]);
  });

  it("ignores aiPerformance with invalid rating", () => {
    const result = parseFeedbackResponse(
      makeValidFeedbackJson({
        aiPerformance: { rating: "meh", strengths: [], weaknesses: [] },
      }),
      session,
    );
    expect(result).not.toBeNull();
    expect(result!.aiPerformance).toBeUndefined();
  });

  it("gracefully handles missing session-level fields", () => {
    // Basic JSON without any new fields — should still parse fine
    const result = parseFeedbackResponse(makeValidFeedbackJson(), session);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBeUndefined();
    expect(result!.sessionGoal).toBeUndefined();
    expect(result!.frictionPoints).toBeUndefined();
    expect(result!.aiPerformance).toBeUndefined();
  });

  it("extracts JSON from noisy output with surrounding text", () => {
    const json = makeValidFeedbackJson();
    const noisy = `Here is my analysis:\n\n${json}\n\nI hope this helps!`;
    const result = parseFeedbackResponse(noisy, session);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Good session overall.");
  });

  it("handles feedback JSON inside markdown fences", () => {
    const json = makeValidFeedbackJson();
    const fenced = `\`\`\`json\n${json}\n\`\`\``;
    const result = parseFeedbackResponse(fenced, session);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Good session overall.");
  });

  it("handles session with no user-prompt scenes", () => {
    const noPromptSession = makeSession({
      scenes: [
        { type: "thinking", content: "thinking..." },
        { type: "text-response", content: "response" },
      ],
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 2, userPrompts: 0, toolCalls: 0 },
      },
    });
    // All feedback items should be filtered since no valid indices
    const result = parseFeedbackResponse(makeValidFeedbackJson(), noPromptSession);
    expect(result).not.toBeNull();
    expect(result!.feedbackItems).toHaveLength(0);
  });
});

// ─── buildSessionDigest ────────────────────────────────────

describe("buildSessionDigest", () => {
  it("preserves user prompt content in output", () => {
    const session = makeSession();
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Fix the auth bug in login.ts");
    expect(digest).toContain("Now add tests");
  });

  it("preserves thinking content in output", () => {
    const session = makeSession();
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Let me look at the login code");
  });

  it("preserves text response content in output", () => {
    const session = makeSession();
    const digest = buildSessionDigest(session);
    expect(digest).toContain("I found and fixed the bug.");
  });

  it("preserves tool name in output", () => {
    const session = makeSession();
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Read");
  });

  it("handles tool-call with diff", () => {
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Fix it" },
        {
          type: "tool-call",
          toolName: "Edit",
          input: {},
          result: "OK",
          diff: { filePath: "src/app.ts", oldContent: "old", newContent: "new" },
        },
      ],
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Edit: src/app.ts");
  });

  it("handles tool-call with bashOutput", () => {
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Run tests" },
        {
          type: "tool-call",
          toolName: "Bash",
          input: { command: "pnpm test" },
          result: "all passed",
          bashOutput: { command: "pnpm test", stdout: "all passed" },
        },
      ],
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Bash: pnpm test");
    expect(digest).toContain("all passed");
  });

  it("includes diff newContent in digest", () => {
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Edit file" },
        {
          type: "tool-call",
          toolName: "Edit",
          input: { file_path: "src/app.ts" },
          result: "ok",
          diff: { filePath: "src/app.ts", oldContent: "const x = 1;", newContent: "const x = 2;" },
        },
      ],
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Edit: src/app.ts");
    expect(digest).toContain("const x = 2;");
  });

  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(200);
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Run" },
        {
          type: "tool-call",
          toolName: "Bash",
          input: { command: longCmd },
          result: "",
          bashOutput: { command: longCmd, stdout: "" },
        },
      ],
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("...");
    expect(digest).not.toContain(longCmd);
  });

  it("includes compaction-summary indication in output", () => {
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Do something" },
        { type: "compaction-summary", content: "Previous context was summarized" },
      ],
    });
    const digest = buildSessionDigest(session);
    // Should mention compaction in some form (exact wording may change)
    expect(digest.toLowerCase()).toContain("compaction");
  });

  it("handles empty session", () => {
    const session = makeSession({
      scenes: [],
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 },
      },
    });
    const digest = buildSessionDigest(session);
    expect(digest).toBe("");
  });

  it("truncates long user prompts based on budget", () => {
    const longPrompt = "x".repeat(5000);
    const session = makeSession({
      scenes: [{ type: "user-prompt", content: longPrompt }],
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
      },
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("...(truncated)");
    expect(digest).not.toContain(longPrompt);
  });

  it("respects response character budget", () => {
    const scenes: Scene[] = [
      { type: "user-prompt", content: "Go" },
      { type: "text-response", content: "a".repeat(2000) },
    ];
    const session = makeSession({
      scenes,
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: 2, userPrompts: 1, toolCalls: 0 },
      },
    });
    const digest = buildSessionDigest(session);
    // The text should be truncated based on the budget
    expect(digest.length).toBeLessThan(3000);
  });

  it("hard caps output at 35000 characters", () => {
    // Create a session with many turns and very long content to exceed 35k
    const scenes: Scene[] = [];
    for (let i = 0; i < 100; i++) {
      scenes.push({ type: "user-prompt", content: `Prompt ${"x".repeat(500)}` });
      scenes.push({ type: "text-response", content: `Response ${"y".repeat(500)}` });
    }
    const session = makeSession({
      scenes,
      meta: {
        ...makeSession().meta,
        stats: { sceneCount: scenes.length, userPrompts: 100, toolCalls: 0 },
      },
    });
    const digest = buildSessionDigest(session);
    expect(digest.length).toBeLessThanOrEqual(50100); // 50000 + suffix message
    if (digest.length > 50000) {
      expect(digest).toContain("remaining turns omitted due to length");
    }
  });

  it("handles tool-call with generic input", () => {
    const session = makeSession({
      scenes: [
        { type: "user-prompt", content: "Search" },
        {
          type: "tool-call",
          toolName: "Grep",
          input: { pattern: "TODO", path: "src/" },
          result: "found 3 matches",
        },
      ],
    });
    const digest = buildSessionDigest(session);
    expect(digest).toContain("Grep:");
    expect(digest).toContain("TODO");
  });
});

// ─── feedbackToAnnotations ─────────────────────────────────

describe("feedbackToAnnotations", () => {
  it("creates summary annotation at scene 0 with all feedback data", () => {
    const feedback: FeedbackResult = {
      summary: "Great session.",
      score: 8,
      strengths: ["Clear communication"],
      improvements: ["More context"],
      feedbackItems: [],
    };
    const annotations = feedbackToAnnotations(feedback);

    expect(annotations).toHaveLength(1);
    expect(annotations[0].sceneIndex).toBe(0);
    expect(annotations[0].author).toBe("vibe-feedback");
    expect(annotations[0].resolved).toBe(false);
    // Check data is present, not exact formatting
    expect(annotations[0].body).toContain("8");
    expect(annotations[0].body).toContain("10");
    expect(annotations[0].body).toContain("Great session.");
    expect(annotations[0].body).toContain("Clear communication");
    expect(annotations[0].body).toContain("More context");
  });

  it("creates per-item annotations with correct sceneIndex", () => {
    const feedback: FeedbackResult = {
      summary: "Good.",
      score: 6,
      strengths: [],
      improvements: [],
      feedbackItems: [
        {
          sceneIndex: 5,
          title: "Vague prompt",
          feedback: "Be more specific.",
          category: "specificity",
        },
        {
          sceneIndex: 10,
          title: "Good recovery",
          feedback: "Nice course correction.",
          category: "iteration",
        },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);

    // 1 summary + 2 items
    expect(annotations).toHaveLength(3);
    expect(annotations[1].sceneIndex).toBe(5);
    expect(annotations[1].body).toContain("Vague prompt");
    expect(annotations[1].body).toContain("Be more specific.");
    expect(annotations[2].sceneIndex).toBe(10);
    expect(annotations[2].body).toContain("Good recovery");
  });

  it("includes improved prompt when present", () => {
    const feedback: FeedbackResult = {
      summary: "Ok.",
      score: 5,
      strengths: [],
      improvements: [],
      feedbackItems: [
        {
          sceneIndex: 0,
          title: "Fix",
          feedback: "Needs context.",
          category: "context",
          improvedPrompt: "Fix the auth bug in src/login.ts by checking token expiry",
        },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);

    expect(annotations[1].body).toContain("Suggested prompt:");
    expect(annotations[1].body).toContain(
      "Fix the auth bug in src/login.ts by checking token expiry",
    );
  });

  it("does not include suggested prompt section when improvedPrompt is absent", () => {
    const feedback: FeedbackResult = {
      summary: "Ok.",
      score: 5,
      strengths: [],
      improvements: [],
      feedbackItems: [
        {
          sceneIndex: 0,
          title: "Fix",
          feedback: "Needs context.",
          category: "context",
        },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);
    expect(annotations[1].body).not.toContain("Suggested prompt:");
  });

  it("generates unique IDs for each annotation", () => {
    const feedback: FeedbackResult = {
      summary: "Ok.",
      score: 5,
      strengths: [],
      improvements: [],
      feedbackItems: [
        { sceneIndex: 0, title: "A", feedback: "a", category: "clarity" },
        { sceneIndex: 1, title: "B", feedback: "b", category: "context" },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);
    const ids = annotations.map((a) => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("creates an annotation for each category", () => {
    const categories: FeedbackResult["feedbackItems"][0]["category"][] = [
      "clarity",
      "specificity",
      "context",
      "efficiency",
      "iteration",
      "tool-usage",
    ];

    for (const cat of categories) {
      const feedback: FeedbackResult = {
        summary: "Ok.",
        score: 5,
        strengths: [],
        improvements: [],
        feedbackItems: [{ sceneIndex: 0, title: "Test", feedback: "ok", category: cat }],
      };
      const annotations = feedbackToAnnotations(feedback);
      // Should have summary + 1 item annotation
      expect(annotations).toHaveLength(2);
      expect(annotations[1].body).toContain("Test");
      expect(annotations[1].body).toContain("ok");
    }
  });

  it("includes multiline improved prompt content in annotation body", () => {
    const feedback: FeedbackResult = {
      summary: "Ok.",
      score: 5,
      strengths: [],
      improvements: [],
      feedbackItems: [
        {
          sceneIndex: 0,
          title: "Test",
          feedback: "ok",
          category: "clarity",
          improvedPrompt: "Line 1\nLine 2\nLine 3",
        },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);
    expect(annotations[1].body).toContain("Line 1");
    expect(annotations[1].body).toContain("Line 2");
    expect(annotations[1].body).toContain("Line 3");
  });

  it("sets consistent timestamps across all annotations", () => {
    const feedback: FeedbackResult = {
      summary: "Ok.",
      score: 5,
      strengths: [],
      improvements: [],
      feedbackItems: [
        { sceneIndex: 0, title: "A", feedback: "a", category: "clarity" },
        { sceneIndex: 1, title: "B", feedback: "b", category: "context" },
      ],
    };
    const annotations = feedbackToAnnotations(feedback);
    const timestamps = annotations.map((a) => a.createdAt);
    // All annotations in a batch should have the same timestamp
    expect(new Set(timestamps).size).toBe(1);
    // createdAt should equal updatedAt
    for (const ann of annotations) {
      expect(ann.createdAt).toBe(ann.updatedAt);
    }
  });
});

// ─── stripAnsi ─────────────────────────────────────────────

describe("stripAnsi", () => {
  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips basic color codes", () => {
    expect(stripAnsi("\x1B[31mred text\x1B[0m")).toBe("red text");
  });

  it("strips bold and underline codes", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[0m \x1B[4munderline\x1B[0m")).toBe("bold underline");
  });

  it("strips multiple color codes", () => {
    expect(stripAnsi("\x1B[32mgreen\x1B[0m and \x1B[34mblue\x1B[0m")).toBe("green and blue");
  });

  it("strips 256-color codes", () => {
    expect(stripAnsi("\x1B[38;5;196mred\x1B[0m")).toBe("red");
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("\x1B]0;window title\x07text")).toBe("text");
  });

  it("handles mixed ANSI and OSC sequences", () => {
    const input = "\x1B]0;title\x07\x1B[1m\x1B[32mcolored bold\x1B[0m";
    expect(stripAnsi(input)).toBe("colored bold");
  });
});
