import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../src/types.js";

const quickShareState = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: null as null | ((value: unknown) => void),
}));

vi.mock("../src/replay-share.js", () => ({
  QuickShareTooLargeError: class QuickShareTooLargeError extends Error {},
  createQuickReplayShare: quickShareState.create,
}));

vi.mock("../src/overlays.js", () => ({
  loadOverlays: vi.fn(async () => ({})),
  sessionForExternalOutput: (session: ReplaySession) => session,
  sessionWithEffectiveContent: (session: ReplaySession) => session,
}));

const { registerSessionOutputRoutes } = await import("../src/server-routes/session-output.js");

function replay(): ReplaySession {
  return {
    schemaVersion: 1,
    meta: {
      sessionId: "session-1",
      slug: "session-1",
      provider: "codex",
      project: "~/project",
      generator: { name: "vibe-replay", version: "0.0.0", generatedAt: "2026-09-21" },
      stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0, durationMs: 0 },
    },
    scenes: [{ type: "user-prompt", content: "hello" }],
  } as ReplaySession;
}

beforeEach(() => {
  quickShareState.create.mockReset();
  quickShareState.resolve = null;
  quickShareState.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        quickShareState.resolve = resolve;
      }),
  );
});

describe("Quick Share routes", () => {
  it("serializes concurrent creation for the same replay", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const first = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    const second = app.request("/api/share/quick?slug=session-1", { method: "POST" });

    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(1));
    quickShareState.resolve!({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      stop: vi.fn(async () => {}),
    });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(await firstResponse.json()).toEqual(await secondResponse.json());
    expect(quickShareState.create).toHaveBeenCalledTimes(1);
  });
});
