import { useState, useCallback, useEffect, useMemo } from "react";
import type { Annotation, ReplaySession } from "../types";

export interface AnnotationActions {
  annotations: Annotation[];
  annotatedScenes: Set<number>;
  annotationCounts: Map<number, number>;
  add: (sceneIndex: number, body: string) => void;
  update: (id: string, body: string) => void;
  remove: (id: string) => void;
  hasUnsaved: boolean;
  canSaveHtml: boolean;
  downloadHtml: () => void;
  downloadJson: () => void;
}

const LS_PREFIX = "vibe-replay-annotations-";

function storageKey(sessionId: string): string {
  return LS_PREFIX + sessionId;
}

export function useAnnotations(session: ReplaySession): AnnotationActions {
  const sessionId = session.meta.sessionId;

  // Save HTML only works from self-contained production builds (data embedded inline).
  // In dev mode (?file=), document.documentElement.outerHTML captures Vite dev scripts
  // that won't work standalone. Use Export JSON instead.
  const canSaveHtml = !!window.__VIBE_REPLAY_DATA__;

  // Initialize from embedded data, then overlay localStorage draft
  const [annotations, setAnnotations] = useState<Annotation[]>(() => {
    const embedded = session.annotations ?? [];
    try {
      const draft = localStorage.getItem(storageKey(sessionId));
      if (draft) {
        const parsed = JSON.parse(draft) as Annotation[];
        // Draft takes precedence if it has content
        if (parsed.length > 0 || embedded.length === 0) return parsed;
      }
    } catch { /* ignore */ }
    return embedded;
  });

  // Track whether we've diverged from embedded
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(session.annotations ?? []),
  );

  const hasUnsaved = JSON.stringify(annotations) !== savedSnapshot;

  // Autosave to localStorage on changes
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(annotations));
    } catch { /* quota exceeded — silent */ }
  }, [annotations, sessionId]);

  const annotatedScenes = useMemo(
    () => new Set(annotations.map((a) => a.sceneIndex)),
    [annotations],
  );

  const annotationCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of annotations) {
      counts.set(a.sceneIndex, (counts.get(a.sceneIndex) || 0) + 1);
    }
    return counts;
  }, [annotations]);

  const add = useCallback((sceneIndex: number, body: string) => {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      sceneIndex,
      body,
      author: "anonymous",
      createdAt: now,
      updatedAt: now,
      resolved: false,
    };
    setAnnotations((prev) => [...prev, annotation]);
  }, []);

  const update = useCallback((id: string, body: string) => {
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, body, updatedAt: new Date().toISOString() } : a,
      ),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const downloadHtml = useCallback(() => {
    // Build the updated data assignment (escape </ for safe embedding in <script>)
    const updatedSession: ReplaySession = { ...session, annotations };
    const jsonData = JSON.stringify(updatedSession).replace(/<\//g, "<\\/");
    const dataAssignment = "window.__VIBE_REPLAY_DATA__ = " + jsonData + ";";

    // Use DOM manipulation to update the data script — no fragile regex needed.
    // generator.ts injects <script id="vibe-replay-data">, so we can find it by ID.
    const dataEl = document.getElementById("vibe-replay-data");
    if (dataEl) {
      // Swap content, serialize, restore (so the running page isn't affected)
      const original = dataEl.textContent;
      dataEl.textContent = dataAssignment;
      const updatedHtml = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      dataEl.textContent = original;
      triggerDownload(updatedHtml);
    } else {
      // Legacy fallback for HTML generated before the id attribute was added:
      // Insert a new identified script into <head>, serialize, then remove it.
      const script = document.createElement("script");
      script.id = "vibe-replay-data";
      script.textContent = dataAssignment;
      document.head.appendChild(script);
      const updatedHtml = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      document.head.removeChild(script);
      triggerDownload(updatedHtml);
    }

    function triggerDownload(html: string) {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${session.meta.slug || "replay"}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Mark as saved
    setSavedSnapshot(JSON.stringify(annotations));
    try {
      localStorage.removeItem(storageKey(sessionId));
    } catch { /* ignore */ }
  }, [session, annotations, sessionId]);

  const downloadJson = useCallback(() => {
    const updatedSession: ReplaySession = { ...session, annotations };
    const json = JSON.stringify(updatedSession, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "replay.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Mark as saved
    setSavedSnapshot(JSON.stringify(annotations));
    try {
      localStorage.removeItem(storageKey(sessionId));
    } catch { /* ignore */ }
  }, [session, annotations, sessionId]);

  return { annotations, annotatedScenes, annotationCounts, add, update, remove, hasUnsaved, canSaveHtml, downloadHtml, downloadJson };
}
