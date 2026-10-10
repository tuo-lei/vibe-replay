import { join, resolve } from "node:path";
import { scopedSessionSlug } from "./server-persistence.js";
import type { ReplaySession, SessionOverlays } from "./types.js";

import { readSidecar } from "./sidecar.js";

const EMPTY_OVERLAYS: SessionOverlays = { version: 1, overlays: [] };

/**
 * Load overlays.json for a session, falling back to ./vibe-replay/<slug> for
 * legacy layouts. Returns EMPTY_OVERLAYS when no file is found.
 */
export async function loadOverlays(
  baseDir: string,
  slug: string,
  targetId?: string,
  allowLegacyFallback = true,
  strict = false,
): Promise<SessionOverlays> {
  const dirs = targetId
    ? [join(baseDir, scopedSessionSlug(slug, targetId))]
    : allowLegacyFallback
      ? [join(baseDir, slug), resolve("./vibe-replay", slug)]
      : [join(baseDir, slug)];
  for (const dir of dirs) {
    const parsed = await readSidecar<SessionOverlays>(
      join(dir, "overlays.json"),
      (value) => {
        const data = value as SessionOverlays | null;
        return (
          !!data &&
          typeof data === "object" &&
          Array.isArray(data.overlays) &&
          (!strict ||
            (data.version === 1 &&
              data.overlays.every(
                (o) =>
                  !!o &&
                  Number.isSafeInteger(o.sceneIndex) &&
                  o.sceneIndex >= 0 &&
                  typeof o.modifiedValue === "string" &&
                  typeof o.updatedAt === "string",
              )))
        );
      },
      strict,
    );
    if (parsed) return parsed;
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

/** Remove local-only SSH metadata before any share or export operation. */
export function sessionForExternalOutput(session: ReplaySession): ReplaySession {
  if (session.meta.location?.kind !== "ssh" || !session.meta.gitRepo) return session;
  const meta = { ...session.meta };
  delete meta.gitRepo;
  return { ...session, meta };
}
