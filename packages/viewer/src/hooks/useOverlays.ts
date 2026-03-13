import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplaySession, SceneOverlay, SessionOverlays } from "../types";
import type { ViewerMode } from "./useSessionLoader";

export interface OverlayActions {
  overlays: SessionOverlays;
  /** Get effective content for a scene (overlay if present, otherwise original) */
  getEffectiveContent: (sceneIndex: number) => string | null;
  /** Check if a scene has an active overlay */
  hasOverlay: (sceneIndex: number) => boolean;
  /** Get all overlays for a specific scene (may have multiple source types) */
  getOverlays: (sceneIndex: number) => SceneOverlay[];
  /** Total overlay count */
  overlayCount: number;
  /** Set overlays (used after AI Studio operations) */
  setOverlays: (overlays: SessionOverlays) => void;
  /** Revert a single overlay */
  revertOverlay: (id: string) => void;
  /** Revert all overlays for a scene */
  revertSceneOverlays: (sceneIndex: number) => void;
  /** Revert all overlays */
  revertAll: () => void;
  /** Update an overlay's modified value (manual edit) */
  updateOverlay: (id: string, modifiedValue: string) => void;
  /** Whether to show original text for a specific scene */
  showOriginal: Set<number>;
  /** Toggle showing original text for a scene */
  toggleOriginal: (sceneIndex: number) => void;
  /** Whether all scenes are showing originals (global toggle) */
  showAllOriginals: boolean;
  /** Toggle all scenes between original and modified */
  toggleAllOriginals: () => void;
  /** AI Studio tool info */
  studioTools: Array<{ name: string }>;
  studioToolName: string | null;
  setStudioToolName: ((name: string) => void) | null;
  studioToolsAvailable: boolean;
  /** Running states */
  translating: boolean;
  toningDown: boolean;
  /** Abort controllers */
  cancelStudio: (() => void) | null;
  /** Run translation */
  runTranslate:
    | ((opts: { targetLang: string; sourceLang?: string }) => Promise<{
        translated: number;
        skipped: number;
      }>)
    | null;
  /** Run tone adjustment */
  runTone:
    | ((opts: { style: "professional" | "neutral" | "friendly" }) => Promise<{
        adjusted: number;
        skipped: number;
      }>)
    | null;
}

const EMPTY_OVERLAYS: SessionOverlays = { version: 1, overlays: [] };

/** Build API URL with slug query param */
function apiUrl(path: string): string {
  const slug = new URLSearchParams(window.location.search).get("session");
  if (!slug) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}slug=${encodeURIComponent(slug)}`;
}

export function useOverlays(session: ReplaySession, mode: ViewerMode = "embedded"): OverlayActions {
  const isEditor = mode === "editor";
  const [overlays, setOverlaysState] = useState<SessionOverlays>(EMPTY_OVERLAYS);
  const [showOriginal, setShowOriginal] = useState<Set<number>>(new Set());
  const [showAllOriginals, setShowAllOriginals] = useState(false);

  // Tool detection (same endpoint as AI Coach, reused)
  const [studioTools, setStudioTools] = useState<Array<{ name: string }>>([]);
  const [studioToolName, setStudioToolNameState] = useState<string | null>(null);

  // Running states
  const [translating, setTranslating] = useState(false);
  const [toningDown, setToningDown] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Save timer for debounced persistence
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load overlays on mount
  useEffect(() => {
    if (!isEditor) return;
    fetch(apiUrl("/api/overlays"))
      .then((r) => r.json())
      .then((data) => {
        if (data && Array.isArray(data.overlays)) {
          setOverlaysState(data as SessionOverlays);
        }
      })
      .catch(() => {});
  }, [isEditor]);

  // Detect tools
  useEffect(() => {
    if (!isEditor) return;
    fetch(apiUrl("/api/feedback/detect"))
      .then((r) => r.json())
      .then((data) => {
        if (!data.available) return;
        const tools: Array<{ name: string }> = Array.isArray(data.tools)
          ? data.tools
          : data.tool
            ? [data.tool]
            : [];
        setStudioTools(tools);
        const defaultName = data.defaultTool?.name || data.tool?.name || tools[0]?.name || null;
        setStudioToolNameState(defaultName);
      })
      .catch(() => {});
  }, [isEditor]);

  // Debounced save to server
  useEffect(() => {
    if (!isEditor) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch(apiUrl("/api/overlays"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overlays),
      }).catch(() => {});
    }, 1000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [overlays, isEditor]);

  const getEffectiveContent = useCallback(
    (sceneIndex: number): string | null => {
      const scene = session.scenes[sceneIndex];
      if (!scene) return null;
      if (scene.type !== "user-prompt" && scene.type !== "text-response") return null;
      if (showAllOriginals || showOriginal.has(sceneIndex)) return scene.content;
      // When multiple overlays exist for a scene, use the most recently updated one
      const sceneOverlays = overlays.overlays.filter((o) => o.sceneIndex === sceneIndex);
      if (sceneOverlays.length === 0) return scene.content;
      const latest = sceneOverlays.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      return latest.modifiedValue;
    },
    [session.scenes, overlays, showOriginal, showAllOriginals],
  );

  const hasOverlay = useCallback(
    (sceneIndex: number): boolean => overlays.overlays.some((o) => o.sceneIndex === sceneIndex),
    [overlays],
  );

  const getOverlays = useCallback(
    (sceneIndex: number): SceneOverlay[] =>
      overlays.overlays.filter((o) => o.sceneIndex === sceneIndex),
    [overlays],
  );

  const setOverlays = useCallback((newOverlays: SessionOverlays) => {
    setOverlaysState(newOverlays);
  }, []);

  const revertOverlay = useCallback((id: string) => {
    setOverlaysState((prev) => ({
      ...prev,
      overlays: prev.overlays.filter((o) => o.id !== id),
    }));
  }, []);

  const revertSceneOverlays = useCallback((sceneIndex: number) => {
    setOverlaysState((prev) => ({
      ...prev,
      overlays: prev.overlays.filter((o) => o.sceneIndex !== sceneIndex),
    }));
  }, []);

  const revertAll = useCallback(() => {
    setOverlaysState(EMPTY_OVERLAYS);
  }, []);

  const updateOverlay = useCallback((id: string, modifiedValue: string) => {
    setOverlaysState((prev) => ({
      ...prev,
      overlays: prev.overlays.map((o) =>
        o.id === id
          ? {
              ...o,
              modifiedValue,
              source: { type: "manual" as const },
              updatedAt: new Date().toISOString(),
            }
          : o,
      ),
    }));
  }, []);

  const toggleOriginal = useCallback((sceneIndex: number) => {
    setShowOriginal((prev) => {
      const next = new Set(prev);
      if (next.has(sceneIndex)) next.delete(sceneIndex);
      else next.add(sceneIndex);
      return next;
    });
  }, []);

  const toggleAllOriginals = useCallback(() => {
    setShowAllOriginals((prev) => !prev);
  }, []);

  const setStudioToolName = isEditor ? (name: string) => setStudioToolNameState(name) : null;

  const cancelStudio = isEditor
    ? () => {
        if (abortRef.current) abortRef.current.abort();
      }
    : null;

  const runTranslate =
    isEditor && studioToolName
      ? async (opts: { targetLang: string; sourceLang?: string }) => {
          const controller = new AbortController();
          abortRef.current = controller;
          setTranslating(true);
          try {
            const resp = await fetch(apiUrl("/api/studio/translate"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                toolName: studioToolName,
                targetLang: opts.targetLang,
                sourceLang: opts.sourceLang,
              }),
              signal: controller.signal,
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || "Translation failed");
            if (data.overlays) setOverlaysState(data.overlays as SessionOverlays);
            return data.stats as { translated: number; skipped: number };
          } finally {
            abortRef.current = null;
            setTranslating(false);
          }
        }
      : null;

  const runTone =
    isEditor && studioToolName
      ? async (opts: { style: "professional" | "neutral" | "friendly" }) => {
          const controller = new AbortController();
          abortRef.current = controller;
          setToningDown(true);
          try {
            const resp = await fetch(apiUrl("/api/studio/tone"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                toolName: studioToolName,
                style: opts.style,
              }),
              signal: controller.signal,
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || "Tone adjustment failed");
            if (data.overlays) setOverlaysState(data.overlays as SessionOverlays);
            return data.stats as { adjusted: number; skipped: number };
          } finally {
            abortRef.current = null;
            setToningDown(false);
          }
        }
      : null;

  return {
    overlays,
    getEffectiveContent,
    hasOverlay,
    getOverlays,
    overlayCount: overlays.overlays.length,
    setOverlays,
    revertOverlay,
    revertSceneOverlays,
    revertAll,
    updateOverlay,
    showOriginal,
    toggleOriginal,
    showAllOriginals,
    toggleAllOriginals,
    studioTools,
    studioToolName,
    setStudioToolName,
    studioToolsAvailable: studioTools.length > 0,
    translating,
    toningDown,
    cancelStudio,
    runTranslate,
    runTone,
  };
}
