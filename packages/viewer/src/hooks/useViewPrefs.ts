import { useCallback, useState } from "react";

export type DisplayMode = "all" | "compact" | "custom";

export interface ViewPrefs {
  displayMode: DisplayMode;
  // Custom mode settings (only active when displayMode === "custom")
  hideThinking: boolean;
  collapseAllTools: boolean;
  promptsOnly: boolean;
}

/** Derived booleans from the active display mode */
export interface EffectivePrefs {
  hideThinking: boolean;
  collapseAllTools: boolean;
  promptsOnly: boolean;
  /** Compact mode: assistant groups show a summary instead of all scenes */
  compactAssistant: boolean;
}

export function getEffectivePrefs(prefs: ViewPrefs): EffectivePrefs {
  switch (prefs.displayMode) {
    case "all":
      return {
        hideThinking: false,
        collapseAllTools: false,
        promptsOnly: false,
        compactAssistant: false,
      };
    case "compact":
      return {
        hideThinking: true,
        collapseAllTools: true,
        promptsOnly: false,
        compactAssistant: true,
      };
    case "custom":
      return {
        hideThinking: prefs.hideThinking,
        collapseAllTools: prefs.collapseAllTools,
        promptsOnly: prefs.promptsOnly,
        compactAssistant: false,
      };
  }
}

const STORAGE_KEY = "vibe-replay-view-prefs";

const defaultPrefs: ViewPrefs = {
  displayMode: "compact",
  hideThinking: false,
  collapseAllTools: false,
  promptsOnly: false,
};

function loadPrefs(): ViewPrefs {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Migration: old prefs without displayMode
      if (!parsed.displayMode) {
        return { ...defaultPrefs, ...parsed, displayMode: "compact" };
      }
      return { ...defaultPrefs, ...parsed };
    }
  } catch {}
  return defaultPrefs;
}

export function useViewPrefs() {
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);

  const updatePref = useCallback(<K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const togglePref = useCallback((key: keyof ViewPrefs) => {
    setPrefs((prev) => {
      const val = prev[key];
      if (typeof val !== "boolean") return prev;
      const next = { ...prev, [key]: !val };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { prefs, updatePref, togglePref };
}
