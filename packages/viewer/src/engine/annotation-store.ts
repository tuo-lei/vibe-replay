import type { Annotation } from "../types";

/** Add a new annotation to the list (pure — returns new array) */
export function addAnnotation(
  annotations: Annotation[],
  sceneIndex: number,
  body: string,
  id?: string,
): Annotation[] {
  const now = new Date().toISOString();
  const annotation: Annotation = {
    id: id ?? crypto.randomUUID(),
    sceneIndex,
    body,
    author: "anonymous",
    createdAt: now,
    updatedAt: now,
    resolved: false,
  };
  return [...annotations, annotation];
}

/** Update an annotation's body by id (pure — returns new array) */
export function updateAnnotation(
  annotations: Annotation[],
  id: string,
  body: string,
): Annotation[] {
  return annotations.map((a) =>
    a.id === id ? { ...a, body, updatedAt: new Date().toISOString() } : a,
  );
}

/** Remove an annotation by id (pure — returns new array) */
export function removeAnnotation(annotations: Annotation[], id: string): Annotation[] {
  return annotations.filter((a) => a.id !== id);
}

/** Compute the set of scene indices that have at least one annotation */
export function computeAnnotatedScenes(annotations: Annotation[]): Set<number> {
  return new Set(annotations.map((a) => a.sceneIndex));
}

/** Compute annotation count per scene index */
export function computeAnnotationCounts(annotations: Annotation[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const a of annotations) {
    counts.set(a.sceneIndex, (counts.get(a.sceneIndex) || 0) + 1);
  }
  return counts;
}

/** Check if current annotations differ from a saved snapshot */
export function hasUnsavedChanges(current: Annotation[], savedSnapshot: string): boolean {
  return JSON.stringify(current) !== savedSnapshot;
}
