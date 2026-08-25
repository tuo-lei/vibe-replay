// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation, ReplaySession, SessionLocation } from "../../types";
import {
  annotationStorageKey,
  legacyAnnotationStorageKey,
  useAnnotations,
} from "../useAnnotations";

function session(provider: string, sceneCount = 30, location?: SessionLocation): ReplaySession {
  const scenes: ReplaySession["scenes"] = Array.from({ length: sceneCount }, (_, index) => ({
    type: "user-prompt",
    content: `Prompt ${index}`,
  }));
  return {
    meta: {
      sessionId: "shared-session",
      slug: "shared-session",
      provider,
      startTime: "2026-01-01T00:00:00.000Z",
      cwd: "~/project",
      project: "~/project",
      ...(location ? { location } : {}),
      stats: { sceneCount, userPrompts: sceneCount, toolCalls: 0 },
    },
    scenes,
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
    expect(annotationStorageKey("claude-code", "shared-session")).not.toBe(
      legacyAnnotationStorageKey("claude-code:shared-session"),
    );
    expect(annotationStorageKey("codex", "shared-session")).not.toBe(
      annotationStorageKey("codex", "shared-session", {
        kind: "ssh",
        id: "remote-a",
        label: "Remote A",
      }),
    );
    expect(
      annotationStorageKey("codex", "shared-session", {
        kind: "ssh",
        id: "remote-a",
        label: "Remote A",
      }),
    ).not.toBe(
      annotationStorageKey("codex", "shared-session", {
        kind: "ssh",
        id: "remote-b",
        label: "Remote B",
      }),
    );
  });

  it.each([30, 500])("loads and migrates legacy drafts for %i scenes", async (sceneCount) => {
    localStorage.setItem(
      legacyAnnotationStorageKey("shared-session"),
      JSON.stringify([annotation]),
    );

    const { result } = renderHook(() =>
      useAnnotations(session("claude-code", sceneCount), "embedded"),
    );
    expect(result.current.annotations).toEqual([annotation]);

    await waitFor(() => {
      expect(localStorage.getItem(annotationStorageKey("claude-code", "shared-session"))).toBe(
        JSON.stringify([annotation]),
      );
    });
    expect(localStorage.getItem(legacyAnnotationStorageKey("shared-session"))).toBeNull();
  });

  it("preserves an intentionally empty scoped draft over embedded annotations", () => {
    localStorage.setItem(annotationStorageKey("claude-code", "shared-session"), "[]");
    const replay = { ...session("claude-code"), annotations: [annotation] };

    const { result } = renderHook(() => useAnnotations(replay, "embedded"));
    expect(result.current.annotations).toEqual([]);
  });

  it("does not load local drafts into an SSH session with the same provider and ID", async () => {
    const remote = {
      kind: "ssh" as const,
      id: "remote-a",
      label: "Remote A",
    };
    const remoteAnnotation = { ...annotation, id: "remote-note", body: "Remote note" };
    localStorage.setItem(
      annotationStorageKey("codex", "shared-session"),
      JSON.stringify([annotation]),
    );
    localStorage.setItem(
      annotationStorageKey("codex", "shared-session", remote),
      JSON.stringify([remoteAnnotation]),
    );

    const { result, rerender } = renderHook(
      ({ location }: { location?: SessionLocation }) =>
        useAnnotations(session("codex", 30, location), "embedded"),
      { initialProps: { location: undefined as SessionLocation | undefined } },
    );
    expect(result.current.annotations).toEqual([annotation]);

    rerender({ location: remote });
    await waitFor(() => expect(result.current.annotations).toEqual([remoteAnnotation]));
  });

  it("migrates the legacy key only for local sessions", async () => {
    const remote = { kind: "ssh" as const, id: "remote-a", label: "Remote A" };
    localStorage.setItem(
      legacyAnnotationStorageKey("shared-session"),
      JSON.stringify([annotation]),
    );

    const { result } = renderHook(() => useAnnotations(session("codex", 30, remote), "embedded"));

    expect(result.current.annotations).toEqual([]);
    await waitFor(() => {
      expect(localStorage.getItem(annotationStorageKey("codex", "shared-session", remote))).toBe(
        "[]",
      );
    });
    expect(localStorage.getItem(legacyAnnotationStorageKey("shared-session"))).toEqual(
      JSON.stringify([annotation]),
    );
  });

  it.each([30, 500])(
    "reloads provider-scoped drafts across %i-scene replay changes",
    async (sceneCount) => {
      const cursorAnnotation = { ...annotation, id: "cursor-note", body: "Cursor note" };
      localStorage.setItem(
        annotationStorageKey("claude-code", "shared-session"),
        JSON.stringify([annotation]),
      );
      localStorage.setItem(
        annotationStorageKey("cursor", "shared-session"),
        JSON.stringify([cursorAnnotation]),
      );

      const { result, rerender } = renderHook(
        ({ provider }) => useAnnotations(session(provider, sceneCount), "embedded"),
        { initialProps: { provider: "claude-code" } },
      );
      expect(result.current.annotations).toEqual([annotation]);

      rerender({ provider: "cursor" });
      await waitFor(() => expect(result.current.annotations).toEqual([cursorAnnotation]));
      expect(localStorage.getItem(annotationStorageKey("cursor", "shared-session"))).toBe(
        JSON.stringify([cursorAnnotation]),
      );
    },
  );
});
