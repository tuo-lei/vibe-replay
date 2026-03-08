import type { Scene } from "../types";
import { findBatchEnd } from "./scene-timing";

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
 * - batch grouping (consecutive same-name batchable tool calls)
 *
 * Returns the target index, or -1 if playback should end.
 */
export function computeNextIndex(
  scenes: Scene[],
  currentIndex: number,
  promptsOnly: boolean,
): number {
  let nextIdx = currentIndex + 1;

  if (nextIdx >= scenes.length) return -1;

  if (promptsOnly) {
    while (nextIdx < scenes.length && scenes[nextIdx].type !== "user-prompt") {
      nextIdx++;
    }
    return nextIdx >= scenes.length ? -1 : nextIdx;
  }

  // For batchable tool calls, skip to the end of the batch
  return findBatchEnd(scenes, nextIdx);
}
