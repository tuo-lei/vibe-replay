import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReplaySession, SessionOverlays } from "./types.js";

const EMPTY_OVERLAYS: SessionOverlays = { version: 1, overlays: [] };

/**
 * Load overlays.json for a session, falling back to ./vibe-replay/<slug> for
 * legacy layouts. Returns EMPTY_OVERLAYS when no file is found.
 */
export async function loadOverlays(baseDir: string, slug: string): Promise<SessionOverlays> {
  const dirs = [join(baseDir, slug), resolve("./vibe-replay", slug)];
  for (const dir of dirs) {
    try {
      const raw = await readFile(join(dir, "overlays.json"), "utf-8");
      const parsed = JSON.parse(raw) as SessionOverlays;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.overlays)) {
        return parsed;
      }
    } catch {
      /* not found */
    }
  }
  return EMPTY_OVERLAYS;
}

/**
 * Apply the latest overlay (by updatedAt) for each scene index to the session.
 * Used so publish/export/AI-chain operations work against the user's edited
 * content, not the raw original.
 */
export function sessionWithEffectiveContent(
  session: ReplaySession,
  existing: SessionOverlays,
): ReplaySession {
  if (existing.overlays.length === 0) return session;
  const latestByScene = new Map<number, { value: string; time: string }>();
  for (const o of existing.overlays) {
    const current = latestByScene.get(o.sceneIndex);
    if (!current || o.updatedAt > current.time) {
      latestByScene.set(o.sceneIndex, { value: o.modifiedValue, time: o.updatedAt });
    }
  }
  if (latestByScene.size === 0) return session;
  return {
    ...session,
    scenes: session.scenes.map((scene, i) => {
      const entry = latestByScene.get(i);
      if (!entry) return scene;
      if (scene.type === "user-prompt" || scene.type === "text-response") {
        return { ...scene, content: entry.value };
      }
      return scene;
    }),
  };
}
