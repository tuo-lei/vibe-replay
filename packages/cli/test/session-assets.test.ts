import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { registerSessionAssetRoutes } from "../src/server-routes/session-assets.js";
import type { Annotation, ReplaySession, SessionOverlays } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session asset target isolation", () => {
  it("does not allow annotations or overlays from another SSH target", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-session-assets-"));
    roots.push(root);
    const app = new Hono();
    registerSessionAssetRoutes(app, {
      baseDir: root,
      loadSession: async (slug, targetId): Promise<ReplaySession> => {
        if (slug !== "shared" || !targetId || !["remote-a", "remote-b"].includes(targetId)) {
          throw new Error("session not found");
        }
        return {
          meta: {
            sessionId: "shared",
            slug: "shared--ssh-a",
            provider: "codex",
            location: { kind: "ssh", id: targetId, label: targetId },
            startTime: "2026-08-24T10:00:00.000Z",
            cwd: "~/project",
            project: "~/project",
            stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
          },
          scenes: [{ type: "user-prompt", content: "A prompt" }],
        };
      },
    });

    const annotation: Annotation = {
      id: "annotation-1",
      sceneIndex: 0,
      body: "Remote note",
      author: "test",
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
      resolved: false,
    };
    const overlays: SessionOverlays = {
      version: 1,
      overlays: [
        {
          id: "overlay-1",
          sceneIndex: 0,
          field: "content",
          originalValue: "A prompt",
          modifiedValue: "A changed prompt",
          source: { type: "manual" },
          createdAt: "2026-08-24T10:00:00.000Z",
          updatedAt: "2026-08-24T10:00:00.000Z",
        },
      ],
    };

    const unknownAnnotationRead = await app.request(
      "/api/annotations?slug=shared&targetId=remote-c",
    );
    expect(unknownAnnotationRead.status).toBe(404);
    const annotationWrite = await app.request("/api/annotations?slug=shared&targetId=remote-a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([annotation]),
    });
    expect(annotationWrite.status).toBe(200);
    const otherAnnotation = { ...annotation, id: "annotation-2", body: "Other remote note" };
    const otherAnnotationWrite = await app.request(
      "/api/annotations?slug=shared&targetId=remote-b",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([otherAnnotation]),
      },
    );
    expect(otherAnnotationWrite.status).toBe(200);
    const correctAnnotationRead = await app.request(
      "/api/annotations?slug=shared&targetId=remote-a",
    );
    expect(await correctAnnotationRead.json()).toEqual([annotation]);
    const otherAnnotationRead = await app.request("/api/annotations?slug=shared&targetId=remote-b");
    expect(await otherAnnotationRead.json()).toEqual([otherAnnotation]);

    const unknownOverlayRead = await app.request("/api/overlays?slug=shared&targetId=remote-c");
    expect(unknownOverlayRead.status).toBe(404);
    const overlayWrite = await app.request("/api/overlays?slug=shared&targetId=remote-a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overlays),
    });
    expect(overlayWrite.status).toBe(200);
    const otherOverlays: SessionOverlays = {
      ...overlays,
      overlays: [{ ...overlays.overlays[0]!, id: "overlay-2", modifiedValue: "Other value" }],
    };
    const otherOverlayWrite = await app.request("/api/overlays?slug=shared&targetId=remote-b", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(otherOverlays),
    });
    expect(otherOverlayWrite.status).toBe(200);
    const correctOverlayRead = await app.request("/api/overlays?slug=shared&targetId=remote-a");
    expect(await correctOverlayRead.json()).toEqual(overlays);
    const otherOverlayRead = await app.request("/api/overlays?slug=shared&targetId=remote-b");
    expect(await otherOverlayRead.json()).toEqual(otherOverlays);
  });
});
