import { describe, expect, it } from "vitest";
import type { Annotation, ReplaySession } from "../types";
import { exportExecutableFeedback } from "./feedback-export";

function makeSession(): ReplaySession {
  return {
    meta: {
      sessionId: "s1",
      slug: "demo-session",
      title: "Demo Session",
      provider: "cursor",
      startTime: "2026-06-10T11:59:00.000Z",
      cwd: "/tmp/demo",
      project: "/tmp/demo",
      stats: {
        sceneCount: 2,
        userPrompts: 1,
        toolCalls: 0,
      },
    },
    scenes: [
      {
        type: "user-prompt",
        content: "Please update the auth flow.",
      },
      {
        type: "text-response",
        content: "I will update auth without adding tests.",
        timestamp: "2026-06-10T12:00:00.000Z",
      },
    ],
  };
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    sceneIndex: 1,
    selectedText: "without adding tests",
    body: "Add a concrete test plan before implementing this.",
    author: "anonymous",
    createdAt: "2026-06-10T12:01:00.000Z",
    updatedAt: "2026-06-10T12:01:00.000Z",
    resolved: false,
    ...overrides,
  };
}

describe("exportExecutableFeedback", () => {
  it("exports selected text, feedback, and scene context", () => {
    const output = exportExecutableFeedback(makeSession(), [makeAnnotation()]);

    expect(output).toContain("# Replay Feedback");
    expect(output).toContain("Session: **Demo Session**");
    expect(output).toContain("## 1. Scene 2 - Assistant response");
    expect(output).toContain("Selected text:");
    expect(output).toContain("without adding tests");
    expect(output).toContain("> Add a concrete test plan before implementing this.");
    expect(output).toContain("I will update auth without adding tests.");
  });

  it("returns an explicit empty-feedback message", () => {
    const output = exportExecutableFeedback(makeSession(), []);

    expect(output).toContain("No feedback annotations were added");
  });
});
