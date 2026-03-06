import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Annotation, ReplaySession } from "../types";
import type { ViewerMode } from "./useSessionLoader";

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
  /** Editor mode: publish to gist via server API */
  publishGist: (() => Promise<{ gistUrl: string; viewerUrl: string }>) | null;
  /** Editor mode: export HTML via server API */
  exportHtml: (() => Promise<string>) | null;
  gistPublishing: boolean;
  htmlExporting: boolean;
}

const LS_PREFIX = "vibe-replay-annotations-";

function storageKey(sessionId: string): string {
  return LS_PREFIX + sessionId;
}

export function useAnnotations(
  session: ReplaySession,
  mode: ViewerMode = "embedded",
): AnnotationActions {
  const sessionId = session.meta.sessionId;
  const isEditor = mode === "editor";

  // Save HTML only works from self-contained production builds (data embedded inline)
  // or in editor mode (server generates it).
  const canSaveHtml = !!window.__VIBE_REPLAY_DATA__ || isEditor;

  // Initialize from embedded data, then overlay localStorage draft
  const [annotations, setAnnotations] = useState<Annotation[]>(() => {
    const embedded = session.annotations ?? [];
    if (isEditor) return embedded; // Editor mode: server is source of truth
    try {
      const draft = localStorage.getItem(storageKey(sessionId));
      if (draft) {
        const parsed = JSON.parse(draft) as Annotation[];
        if (parsed.length > 0 || embedded.length === 0) return parsed;
      }
    } catch { /* ignore */ }
    return embedded;
  });

  // Track whether we've diverged from embedded/server state
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(session.annotations ?? []),
  );

  const hasUnsaved = JSON.stringify(annotations) !== savedSnapshot;

  // Autosave: localStorage for embedded/readonly, API for editor
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isEditor) {
      // Debounced save to server API
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        fetch("/api/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(annotations),
        }).then(() => {
          setSavedSnapshot(JSON.stringify(annotations));
        }).catch(() => { /* silent */ });
      }, 1000);
      return () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      };
    }
    // Non-editor: save to localStorage
    try {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(annotations));
    } catch { /* quota exceeded — silent */ }
  }, [annotations, sessionId, isEditor]);

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
    if (isEditor) return; // Editor mode uses exportHtml instead

    // Build the updated data assignment (escape </ for safe embedding in <script>)
    const updatedSession: ReplaySession = { ...session, annotations };
    const jsonData = JSON.stringify(updatedSession).replace(/<\//g, "<\\/");
    const dataAssignment = "window.__VIBE_REPLAY_DATA__ = " + jsonData + ";";

    // Use DOM manipulation to update the data script — no fragile regex needed.
    const dataEl = document.getElementById("vibe-replay-data");
    if (dataEl) {
      const original = dataEl.textContent;
      dataEl.textContent = dataAssignment;
      const updatedHtml = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      dataEl.textContent = original;
      triggerDownload(updatedHtml);
    } else {
      // Legacy fallback
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

    setSavedSnapshot(JSON.stringify(annotations));
    try {
      localStorage.removeItem(storageKey(sessionId));
    } catch { /* ignore */ }
  }, [session, annotations, sessionId, isEditor]);

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

    setSavedSnapshot(JSON.stringify(annotations));
    try {
      localStorage.removeItem(storageKey(sessionId));
    } catch { /* ignore */ }
  }, [session, annotations, sessionId]);

  // Editor mode: server-side gist publishing
  const [gistPublishing, setGistPublishing] = useState(false);
  const publishGist = isEditor
    ? async () => {
        setGistPublishing(true);
        try {
          // Ensure latest annotations are saved first
          await fetch("/api/annotations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(annotations),
          });
          const resp = await fetch("/api/publish/gist", { method: "POST" });
          const result = await resp.json();
          if (!resp.ok) {
            throw new Error(result.error || `Server error: ${resp.status}`);
          }
          setSavedSnapshot(JSON.stringify(annotations));
          return result as { gistUrl: string; viewerUrl: string };
        } finally {
          setGistPublishing(false);
        }
      }
    : null;

  // Editor mode: server-side HTML export
  const [htmlExporting, setHtmlExporting] = useState(false);
  const exportHtml = isEditor
    ? async () => {
        setHtmlExporting(true);
        try {
          await fetch("/api/annotations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(annotations),
          });
          const resp = await fetch("/api/export/html", { method: "POST" });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || `Export failed: ${resp.status}`);
          const { path } = data;
          setSavedSnapshot(JSON.stringify(annotations));
          return path as string;
        } finally {
          setHtmlExporting(false);
        }
      }
    : null;

  return {
    annotations, annotatedScenes, annotationCounts,
    add, update, remove, hasUnsaved, canSaveHtml,
    downloadHtml, downloadJson,
    publishGist, exportHtml,
    gistPublishing, htmlExporting,
  };
}
