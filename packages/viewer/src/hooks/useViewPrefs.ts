import { useState, useCallback } from "react";

export interface ViewPrefs {
  hideThinking: boolean;
  collapseAllTools: boolean;
  promptsOnly: boolean;
}

const STORAGE_KEY = "vibe-replay-view-prefs";

function loadPrefs(): ViewPrefs {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...defaultPrefs, ...JSON.parse(stored) };
  } catch {}
  return defaultPrefs;
}

const defaultPrefs: ViewPrefs = {
  hideThinking: false,
  collapseAllTools: false,
  promptsOnly: false,
};

export function useViewPrefs() {
  const [prefs, setPrefs] = useState<ViewPrefs>(loadPrefs);

  const updatePref = useCallback(
    <K extends keyof ViewPrefs>(key: K, value: ViewPrefs[K]) => {
      setPrefs((prev) => {
        const next = { ...prev, [key]: value };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  const togglePref = useCallback((key: keyof ViewPrefs) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { prefs, updatePref, togglePref };
}
