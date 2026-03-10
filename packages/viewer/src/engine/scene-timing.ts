import type { Scene } from "../types";

/** Check if a tool-call scene is "simple" (batchable — no diff, no bash output) */
export function isBatchable(scene: Scene): scene is Extract<Scene, { type: "tool-call" }> {
  return scene.type === "tool-call" && !scene.diff && !scene.bashOutput;
}

/** Find the end of a consecutive batch of same-name batchable tool calls starting at idx */
export function findBatchEnd(scenes: Scene[], idx: number): number {
  const scene = scenes[idx];
  if (!isBatchable(scene)) return idx;
  const toolName = scene.toolName;
  let end = idx;
  while (end + 1 < scenes.length && isBatchable(scenes[end + 1])) {
    if ((scenes[end + 1] as Extract<Scene, { type: "tool-call" }>).toolName !== toolName) break;
    end++;
  }
  return end;
}

/** Calculate display duration for a scene at a given playback speed */
export function sceneDuration(scene: Scene, speed: number): number {
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
      case "compaction-summary":
        return 800;
    }
  })();
  return base! / speed;
}
