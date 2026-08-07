// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation, ReplaySession } from "../../types";
import {
  annotationStorageKey,
  legacyAnnotationStorageKey,
  useAnnotations,
} from "../useAnnotations";

function session(provider: string): ReplaySession {
  return {
    meta: {
      sessionId: "shared-session",
      slug: "shared-session",
      provider,
      startTime: "2026-01-01T00:00:00.000Z",
      cwd: "~/project",
      project: "~/project",
      stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 },
    },
    scenes: [],
  };
}

const annotation: Annotation = {
  id: "annotation-1",
  sceneIndex: 0,
  body: "Keep this note",
  author: "Reviewer",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolved: false,
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("useAnnotations storage identity", () => {
  it("keeps identical native session IDs isolated by provider", () => {
    expect(annotationStorageKey("claude-code", "shared-session")).not.toBe(
      annotationStorageKey("cursor", "shared-session"),
    );
  });

  it("loads and migrates legacy session-only drafts", async () => {
    localStorage.setItem(
      legacyAnnotationStorageKey("shared-session"),
      JSON.stringify([annotation]),
    );

    const { result } = renderHook(() => useAnnotations(session("claude-code"), "embedded"));
    expect(result.current.annotations).toEqual([annotation]);

    await waitFor(() => {
      expect(localStorage.getItem(annotationStorageKey("claude-code", "shared-session"))).toBe(
        JSON.stringify([annotation]),
      );
    });
    expect(localStorage.getItem(legacyAnnotationStorageKey("shared-session"))).toBeNull();
  });
});
