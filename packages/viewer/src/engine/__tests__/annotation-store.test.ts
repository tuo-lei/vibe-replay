import { describe, expect, it } from "vitest";
import type { Annotation } from "../../types";
import {
  addAnnotation,
  computeAnnotatedScenes,
  computeAnnotationCounts,
  hasUnsavedChanges,
  removeAnnotation,
  updateAnnotation,
} from "../annotation-store";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "test-id",
    sceneIndex: 0,
    body: "test body",
    author: "anonymous",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    resolved: false,
    ...overrides,
  };
}

// -- addAnnotation --

describe("addAnnotation", () => {
  it("adds annotation to empty list", () => {
    const result = addAnnotation([], 5, "hello", "fixed-id");
    expect(result).toHaveLength(1);
    expect(result[0].sceneIndex).toBe(5);
    expect(result[0].body).toBe("hello");
    expect(result[0].id).toBe("fixed-id");
    expect(result[0].author).toBe("anonymous");
    expect(result[0].resolved).toBe(false);
  });

  it("appends to existing list without mutating", () => {
    const existing = [makeAnnotation({ id: "a" })];
    const result = addAnnotation(existing, 3, "new", "b");
    expect(result).toHaveLength(2);
    expect(existing).toHaveLength(1); // original unchanged
  });

  it("generates UUID if id not provided", () => {
    const result = addAnnotation([], 0, "test");
    expect(result[0].id).toBeTruthy();
    expect(result[0].id).not.toBe("test-id");
  });
});

// -- updateAnnotation --

describe("updateAnnotation", () => {
  it("updates body of matching annotation", () => {
    const list = [
      makeAnnotation({ id: "a", body: "old" }),
      makeAnnotation({ id: "b", body: "keep" }),
    ];
    const result = updateAnnotation(list, "a", "new body");
    expect(result[0].body).toBe("new body");
    expect(result[1].body).toBe("keep");
  });

  it("updates updatedAt timestamp", () => {
    const list = [makeAnnotation({ id: "a", updatedAt: "2024-01-01T00:00:00.000Z" })];
    const result = updateAnnotation(list, "a", "changed");
    expect(result[0].updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
  });

  it("does not mutate original array", () => {
    const list = [makeAnnotation({ id: "a", body: "old" })];
    const result = updateAnnotation(list, "a", "new");
    expect(list[0].body).toBe("old");
    expect(result[0].body).toBe("new");
  });

  it("leaves list unchanged if id not found", () => {
    const list = [makeAnnotation({ id: "a" })];
    const result = updateAnnotation(list, "nonexistent", "new");
    expect(result).toEqual(list);
  });
});

// -- removeAnnotation --

describe("removeAnnotation", () => {
  it("removes annotation by id", () => {
    const list = [
      makeAnnotation({ id: "a" }),
      makeAnnotation({ id: "b" }),
      makeAnnotation({ id: "c" }),
    ];
    const result = removeAnnotation(list, "b");
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("does not mutate original array", () => {
    const list = [makeAnnotation({ id: "a" })];
    const result = removeAnnotation(list, "a");
    expect(list).toHaveLength(1);
    expect(result).toHaveLength(0);
  });

  it("returns same content if id not found", () => {
    const list = [makeAnnotation({ id: "a" })];
    const result = removeAnnotation(list, "nonexistent");
    expect(result).toHaveLength(1);
  });
});

// -- computeAnnotatedScenes --

describe("computeAnnotatedScenes", () => {
  it("returns empty set for empty list", () => {
    expect(computeAnnotatedScenes([])).toEqual(new Set());
  });

  it("returns set of unique scene indices", () => {
    const list = [
      makeAnnotation({ sceneIndex: 1 }),
      makeAnnotation({ sceneIndex: 3 }),
      makeAnnotation({ sceneIndex: 1 }), // duplicate
      makeAnnotation({ sceneIndex: 7 }),
    ];
    expect(computeAnnotatedScenes(list)).toEqual(new Set([1, 3, 7]));
  });
});

// -- computeAnnotationCounts --

describe("computeAnnotationCounts", () => {
  it("returns empty map for empty list", () => {
    expect(computeAnnotationCounts([])).toEqual(new Map());
  });

  it("counts annotations per scene", () => {
    const list = [
      makeAnnotation({ sceneIndex: 1 }),
      makeAnnotation({ sceneIndex: 1 }),
      makeAnnotation({ sceneIndex: 3 }),
      makeAnnotation({ sceneIndex: 1 }),
    ];
    const counts = computeAnnotationCounts(list);
    expect(counts.get(1)).toBe(3);
    expect(counts.get(3)).toBe(1);
    expect(counts.get(0)).toBeUndefined();
  });
});

// -- hasUnsavedChanges --

describe("hasUnsavedChanges", () => {
  it("returns false when annotations match saved", () => {
    const list = [makeAnnotation()];
    const saved = [makeAnnotation()];
    expect(hasUnsavedChanges(list, saved)).toBe(false);
  });

  it("returns true when annotations differ from saved", () => {
    const list = [makeAnnotation({ body: "changed" })];
    const saved = [makeAnnotation({ body: "original" })];
    expect(hasUnsavedChanges(list, saved)).toBe(true);
  });

  it("returns false for empty list and empty saved", () => {
    expect(hasUnsavedChanges([], [])).toBe(false);
  });

  it("returns true when annotation added", () => {
    const list = [makeAnnotation()];
    expect(hasUnsavedChanges(list, [])).toBe(true);
  });

  it("returns true when annotations are in different order (order-sensitive)", () => {
    const a = makeAnnotation({ id: "a", sceneIndex: 0 });
    const b = makeAnnotation({ id: "b", sceneIndex: 1 });
    expect(hasUnsavedChanges([a, b], [b, a])).toBe(true);
  });
});
