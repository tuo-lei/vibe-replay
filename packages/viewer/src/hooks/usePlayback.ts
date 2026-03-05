import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Scene } from "../types";

export type PlayState = "idle" | "playing" | "paused" | "ended";

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute("role");
  return role === "textbox" || role === "combobox";
}

/** Check if a tool-call scene is "simple" (batchable — no diff, no bash output) */
function isBatchable(scene: Scene): boolean {
  return scene.type === "tool-call" && !scene.diff && !scene.bashOutput;
}

/** Find the end of a consecutive batch of same-name batchable tool calls starting at idx */
function findBatchEnd(scenes: Scene[], idx: number): number {
  const scene = scenes[idx];
  if (!isBatchable(scene) || scene.type !== "tool-call") return idx;
  const toolName = scene.toolName;
  let end = idx;
  while (
    end + 1 < scenes.length &&
    scenes[end + 1].type === "tool-call" &&
    isBatchable(scenes[end + 1]) &&
    (scenes[end + 1] as Extract<Scene, { type: "tool-call" }>).toolName === toolName
  ) {
    end++;
  }
  return end;
}

function sceneDuration(scene: Scene, speed: number): number {
  // Base durations calibrated for 1x = smooth reading pace (no jumping feel)
  const base = (() => {
    switch (scene.type) {
      case "user-prompt":
        return 1200;
      case "thinking":
        return 600;
      case "text-response": {
        const chars = scene.content.length;
        // Short text: 800ms, long text: up to 3s
        return Math.max(800, Math.min(chars / 40, 5) * 600);
      }
      case "tool-call": {
        if (scene.diff) return 1200;
        if (scene.bashOutput) return 900;
        return 400;
      }
    }
  })();
  return base / speed;
}

export function usePlayback(scenes: Scene[], promptsOnly = false, enabled = true) {
  const [state, setState] = useState<PlayState>("idle");
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [visibleCount, setVisibleCount] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  const indexRef = useRef(currentIndex);
  const speedRef = useRef(speed);
  const promptsOnlyRef = useRef(promptsOnly);

  stateRef.current = state;
  indexRef.current = currentIndex;
  speedRef.current = speed;
  promptsOnlyRef.current = promptsOnly;

  // Compute user prompt indices for jump navigation
  const userPromptIndices = useMemo(() => {
    const indices: number[] = [];
    scenes.forEach((s, i) => {
      if (s.type === "user-prompt") indices.push(i);
    });
    return indices;
  }, [scenes]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const advanceScene = useCallback(() => {
    if (stateRef.current !== "playing") return;

    let nextIdx = indexRef.current + 1;
    if (nextIdx >= scenes.length) {
      setState("ended");
      setCurrentIndex(scenes.length - 1);
      setVisibleCount(scenes.length);
      return;
    }

    // In prompts-only mode, jump straight to the next user-prompt
    if (promptsOnlyRef.current) {
      while (nextIdx < scenes.length && scenes[nextIdx].type !== "user-prompt") {
        nextIdx++;
      }
      if (nextIdx >= scenes.length) {
        setState("ended");
        setCurrentIndex(scenes.length - 1);
        setVisibleCount(scenes.length);
        return;
      }
      setCurrentIndex(nextIdx);
      setVisibleCount(nextIdx + 1);
      const duration = sceneDuration(scenes[nextIdx], speedRef.current);
      timerRef.current = setTimeout(advanceScene, duration);
      return;
    }

    // For batchable tool calls, skip to the end of the batch
    const endIdx = findBatchEnd(scenes, nextIdx);

    setCurrentIndex(endIdx);
    setVisibleCount(endIdx + 1);

    const duration = sceneDuration(scenes[endIdx], speedRef.current);
    timerRef.current = setTimeout(advanceScene, duration);
  }, [scenes]);

  const play = useCallback(() => {
    if (scenes.length === 0) return;

    if (stateRef.current === "ended") {
      setCurrentIndex(-1);
      setVisibleCount(0);
    }

    setState("playing");
    setTimeout(() => {
      if (indexRef.current < 0) {
        // Starting fresh — check if first scene starts a batch
        const endIdx = findBatchEnd(scenes, 0);
        setCurrentIndex(endIdx);
        setVisibleCount(endIdx + 1);
        const duration = sceneDuration(scenes[endIdx], speedRef.current);
        timerRef.current = setTimeout(advanceScene, duration);
      } else {
        const currentScene = scenes[indexRef.current];
        if (currentScene) {
          const duration = sceneDuration(currentScene, speedRef.current) / 2;
          timerRef.current = setTimeout(advanceScene, duration);
        }
      }
    }, 50);
  }, [scenes, advanceScene]);

  const pause = useCallback(() => {
    clearTimer();
    setState("paused");
  }, [clearTimer]);

  const togglePlayPause = useCallback(() => {
    if (stateRef.current === "playing") {
      pause();
    } else {
      play();
    }
  }, [play, pause]);

  const seekTo = useCallback(
    (index: number) => {
      clearTimer();
      const clamped = Math.max(0, Math.min(index, scenes.length - 1));
      setCurrentIndex(clamped);
      setVisibleCount(clamped + 1);

      if (stateRef.current === "playing") {
        const duration = sceneDuration(scenes[clamped], speedRef.current);
        timerRef.current = setTimeout(advanceScene, duration);
      }

      if (stateRef.current === "ended" || stateRef.current === "idle") {
        setState("paused");
      }
    },
    [scenes, clearTimer, advanceScene],
  );

  const jumpToNextUserPrompt = useCallback(() => {
    const current = indexRef.current;
    const next = userPromptIndices.find((i) => i > current);
    if (next !== undefined) seekTo(next);
  }, [userPromptIndices, seekTo]);

  const jumpToPrevUserPrompt = useCallback(() => {
    const current = indexRef.current;
    const prev = [...userPromptIndices].reverse().find((i) => i < current);
    if (prev !== undefined) seekTo(prev);
  }, [userPromptIndices, seekTo]);

  const changeSpeed = useCallback(
    (newSpeed: number) => {
      setSpeed(newSpeed);
      if (stateRef.current === "playing") {
        clearTimer();
        const currentScene = scenes[indexRef.current];
        if (currentScene) {
          const duration = sceneDuration(currentScene, newSpeed);
          timerRef.current = setTimeout(advanceScene, duration);
        }
      }
    },
    [scenes, clearTimer, advanceScene],
  );

  useEffect(() => clearTimer, [clearTimer]);

  // Keyboard shortcuts — only when enabled (after landing page dismissed)
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Do not hijack keys while user is typing in search/input controls.
      if (isEditableTarget(e.target)) return;
      // Space — play/pause
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlayPause();
      }
      // Arrow right / l — next scene
      else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        seekTo(indexRef.current + 1);
      }
      // Arrow left / j — prev scene
      else if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault();
        seekTo(indexRef.current - 1);
      }
      // n — next user prompt
      else if (e.key === "n") {
        e.preventDefault();
        jumpToNextUserPrompt();
      }
      // p — prev user prompt
      else if (e.key === "p") {
        e.preventDefault();
        jumpToPrevUserPrompt();
      }
      // Home — start
      else if (e.key === "Home") {
        e.preventDefault();
        seekTo(0);
      }
      // End / e — show all
      else if (e.key === "End" || e.key === "e") {
        e.preventDefault();
        seekTo(scenes.length - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, togglePlayPause, seekTo, jumpToNextUserPrompt, jumpToPrevUserPrompt, scenes.length]);

  return {
    state,
    currentIndex,
    visibleCount,
    speed,
    play,
    pause,
    togglePlayPause,
    seekTo,
    changeSpeed,
    jumpToNextUserPrompt,
    jumpToPrevUserPrompt,
    userPromptIndices,
    totalScenes: scenes.length,
  };
}
