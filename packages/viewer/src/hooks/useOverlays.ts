import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplaySession, SceneOverlay, SessionOverlays } from "../types";
import { apiUrl } from "../utils/api";
import { useAiProviderSettings, type AiProviderInfo } from "./useAiProviderSettings";
import type { ViewerMode } from "./useSessionLoader";

export interface OverlayActions {
  overlays: SessionOverlays;
  /** Session with overlays baked in — use this for display/export instead of raw session */
  effectiveSession: ReplaySession;
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
  /** AI Studio provider information */
  studioProviders: AiProviderInfo[];
  studioProviderId: string | null;
  studioModelId: string | null;
  setStudioProviderId: ((providerId: string) => void) | null;
  setStudioModelId: ((modelId: string) => void) | null;
  refreshStudioProviders: (() => Promise<void>) | null;
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
        providerId: string;
        providerName: string;
        modelId: string;
        authType: string;
        authSubscription: boolean;
      }>)
    | null;
  /** Run tone adjustment */
  runTone:
    | ((opts: { style: "professional" | "neutral" | "friendly" }) => Promise<{
        adjusted: number;
        skipped: number;
        providerId: string;
        providerName: string;
        modelId: string;
        authType: string;
        authSubscription: boolean;
      }>)
    | null;
}

const EMPTY_OVERLAYS: SessionOverlays = { version: 1, overlays: [] };

export function useOverlays(session: ReplaySession, mode: ViewerMode = "embedded"): OverlayActions {
  const isEditor = mode === "editor";
  const [overlays, setOverlaysState] = useState<SessionOverlays>(EMPTY_OVERLAYS);
  const [showOriginal, setShowOriginal] = useState<Set<number>>(new Set());
  const [showAllOriginals, setShowAllOriginals] = useState(false);

  // AI provider discovery is shared with all AI Studio operations.
  const aiProviderSettings = useAiProviderSettings(isEditor);
  const {
    aiProviders: studioProviders,
    aiProviderId: studioProviderId,
    aiModelId: studioModelId,
    setAiProviderId: setStudioProviderId,
    setAiModelId: setStudioModelId,
    refreshAiProviders: refreshStudioProviders,
  } = aiProviderSettings;

  // Running states
  const [translating, setTranslating] = useState(false);
  const [toningDown, setToningDown] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Save timer for debounced persistence
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether initial load has completed to avoid saving on mount
  const loadedRef = useRef(false);

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
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, [isEditor]);

  // Abort in-flight studio operations on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Debounced save to server (skip initial load to avoid redundant POST)
  useEffect(() => {
    if (!isEditor || !loadedRef.current) return;
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

  // Baked session: overlays applied to scene content (respects showAllOriginals toggle)
  const effectiveSession = useMemo((): ReplaySession => {
    if (overlays.overlays.length === 0 || showAllOriginals) return session;
    // Group overlays by scene, pick latest by updatedAt
    const grouped = new Map<number, SceneOverlay[]>();
    for (const o of overlays.overlays) {
      const arr = grouped.get(o.sceneIndex);
      if (arr) arr.push(o);
      else grouped.set(o.sceneIndex, [o]);
    }
    const latestByScene = new Map<number, string>();
    for (const [sceneIndex, sceneOverlays] of grouped) {
      const latest = sceneOverlays.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      latestByScene.set(sceneIndex, latest.modifiedValue);
    }
    if (latestByScene.size === 0) return session;
    return {
      ...session,
      scenes: session.scenes.map((scene, i) => {
        if (showOriginal.has(i)) return scene;
        const effective = latestByScene.get(i);
        if (!effective) return scene;
        if (scene.type === "user-prompt" || scene.type === "text-response") {
          return { ...scene, content: effective };
        }
        return scene;
      }),
    };
  }, [session, overlays, showOriginal, showAllOriginals]);

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

  const cancelStudio = useMemo(
    () =>
      isEditor
        ? () => {
            if (abortRef.current) abortRef.current.abort();
          }
        : null,
    [isEditor],
  );

  const runTranslate = useMemo(
    () =>
      isEditor && studioProviderId && studioModelId
        ? async (opts: { targetLang: string; sourceLang?: string }) => {
            const controller = new AbortController();
            abortRef.current = controller;
            setTranslating(true);
            try {
              const resp = await fetch(apiUrl("/api/studio/translate"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  providerId: studioProviderId,
                  ...(studioModelId ? { modelId: studioModelId } : {}),
                  targetLang: opts.targetLang,
                  sourceLang: opts.sourceLang,
                }),
                signal: controller.signal,
              });
              const data = await resp.json();
              if (!resp.ok) throw new Error(data.error || "Translation failed");
              if (data.overlays) setOverlaysState(data.overlays as SessionOverlays);
              return {
                ...(data.stats as { translated: number; skipped: number }),
                providerId: data.providerId as string,
                providerName: data.providerName as string,
                modelId: data.modelId as string,
                authType: data.authType as string,
                authSubscription: data.authSubscription as boolean,
              };
            } finally {
              abortRef.current = null;
              setTranslating(false);
            }
          }
        : null,
    [isEditor, studioModelId, studioProviderId],
  );

  const runTone = useMemo(
    () =>
      isEditor && studioProviderId && studioModelId
        ? async (opts: { style: "professional" | "neutral" | "friendly" }) => {
            const controller = new AbortController();
            abortRef.current = controller;
            setToningDown(true);
            try {
              const resp = await fetch(apiUrl("/api/studio/tone"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  providerId: studioProviderId,
                  ...(studioModelId ? { modelId: studioModelId } : {}),
                  style: opts.style,
                }),
                signal: controller.signal,
              });
              const data = await resp.json();
              if (!resp.ok) throw new Error(data.error || "Tone adjustment failed");
              if (data.overlays) setOverlaysState(data.overlays as SessionOverlays);
              return {
                ...(data.stats as { adjusted: number; skipped: number }),
                providerId: data.providerId as string,
                providerName: data.providerName as string,
                modelId: data.modelId as string,
                authType: data.authType as string,
                authSubscription: data.authSubscription as boolean,
              };
            } finally {
              abortRef.current = null;
              setToningDown(false);
            }
          }
        : null,
    [isEditor, studioModelId, studioProviderId],
  );

  return {
    overlays,
    effectiveSession,
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
    studioProviders,
    studioProviderId,
    studioModelId,
    setStudioProviderId,
    setStudioModelId,
    refreshStudioProviders,
    translating,
    toningDown,
    cancelStudio,
    runTranslate,
    runTone,
  };
}
