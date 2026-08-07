import type { FileDiff, Scene } from "../types";

type ToolScene = Extract<Scene, { type: "tool-call" }>;

/** Return all diffs while remaining compatible with replay files that only have `diff`. */
export function getToolDiffs(scene: ToolScene): FileDiff[] {
  if (scene.diffs?.length) return scene.diffs;
  return scene.diff ? [scene.diff] : [];
}
