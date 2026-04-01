import type { Scene } from "../types";
import { findBatchEnd } from "./scene-timing";

/** Check if a scene type acts as a turn boundary (user prompt, compaction, or context injection) */
function isBoundaryType(type: Scene["type"]): boolean {
  return type === "user-prompt" || type === "compaction-summary" || type === "context-injection";
}

/** Compute indices of all user-prompt scenes */
export function computeUserPromptIndices(scenes: Scene[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].type === "user-prompt") indices.push(i);
  }
  return indices;
}

/** Find the next user prompt index after `current`, or undefined */
export function findNextUserPrompt(
  userPromptIndices: number[],
  current: number,
): number | undefined {
  return userPromptIndices.find((i) => i > current);
}

/** Find the previous user prompt index before `current`, or undefined */
export function findPrevUserPrompt(
  userPromptIndices: number[],
  current: number,
): number | undefined {
  for (let i = userPromptIndices.length - 1; i >= 0; i--) {
    if (userPromptIndices[i] < current) return userPromptIndices[i];
  }
  return undefined;
}

/**
 * Compute the next scene index to display, accounting for:
 * - prompts-only mode (skip non-user-prompt scenes)
 * - compact mode (skip directly to the end of the assistant grouping)
 * - batch grouping (consecutive same-name batchable tool calls)
 *
 * Returns the target index, or -1 if playback should end.
 */
export function computeNextIndex(
  scenes: Scene[],
  currentIndex: number,
  prefs: { promptsOnly: boolean; compactAssistant: boolean },
): number {
  let nextIdx = currentIndex + 1;

  if (nextIdx >= scenes.length) return -1;

  if (prefs.promptsOnly) {
    while (nextIdx < scenes.length && !isBoundaryType(scenes[nextIdx].type)) {
      nextIdx++;
    }
    return nextIdx >= scenes.length ? -1 : nextIdx;
  }

  if (prefs.compactAssistant) {
    const isBoundary = isBoundaryType(scenes[nextIdx].type);
    if (!isBoundary) {
      // It's entering an assistant group. Skip to the LAST scene of this group.
      let end = nextIdx;
      while (end + 1 < scenes.length && !isBoundaryType(scenes[end + 1].type)) {
        end++;
      }
      return end; // Lands on the last scene of the assistant block
    }
  }

  // Fallback: Default ALL mode. For batchable tool calls, skip to the end of the batch
  return findBatchEnd(scenes, nextIdx);
}

/**
 * Compute the previous scene index to display, accounting for:
 * - compact mode (skip backwards past the entire assistant grouping if we are leaving it)
 * - batch grouping (skip backwards past the current batch)
 */
export function computePrevIndex(
  scenes: Scene[],
  currentIndex: number,
  prefs: { promptsOnly: boolean; compactAssistant: boolean },
): number {
  let prevIdx = Math.max(0, currentIndex - 1);
  if (currentIndex <= 0) return 0;

  if (prefs.promptsOnly) {
    while (prevIdx > 0 && !isBoundaryType(scenes[prevIdx].type)) {
      prevIdx--;
    }
    return prevIdx;
  }

  if (prefs.compactAssistant) {
    const isCurrentBoundary = isBoundaryType(scenes[currentIndex].type);

    if (!isCurrentBoundary) {
      // We are inside/at the end of an assistant block. Skip backwards to the previous user prompt.
      let start = currentIndex;
      while (start > 0 && !isBoundaryType(scenes[start - 1].type)) {
        start--;
      }
      return Math.max(0, start - 1);
    }

    // We are at a user prompt. Move back one step.
    // If that step is an assistant scene, it's already the "end" of that block relative to us.
    return Math.max(0, currentIndex - 1);
  }

  // Fallback: Default ALL mode.
  // If the scene we are moving BACK into is part of a batch, skip to the START of that batch
  const targetScene = scenes[prevIdx];
  if (targetScene.type === "tool-call" && !targetScene.diff && !targetScene.bashOutput) {
    const toolName = targetScene.toolName;
    while (
      prevIdx > 0 &&
      scenes[prevIdx - 1].type === "tool-call" &&
      !(scenes[prevIdx - 1] as Extract<Scene, { type: "tool-call" }>).diff &&
      !(scenes[prevIdx - 1] as Extract<Scene, { type: "tool-call" }>).bashOutput &&
      (scenes[prevIdx - 1] as Extract<Scene, { type: "tool-call" }>).toolName === toolName
    ) {
      prevIdx--;
    }
  }

  return prevIdx;
}
