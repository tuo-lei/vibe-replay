import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../src/types.js";

const quickShareState = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: null as null | ((value: unknown) => void),
}));

const overlayState = vi.hoisted(() => ({
  load: vi.fn(async () => ({ version: 1, overlays: [] })),
  apply: vi.fn((session: ReplaySession) => session),
}));

vi.mock("../src/replay-share.js", () => ({
  QUICK_SHARE_MAX_BYTES: 10 * 1024 * 1024,
  QuickShareTooLargeError: class QuickShareTooLargeError extends Error {},
  createQuickReplayShare: quickShareState.create,
}));

vi.mock("../src/overlays.js", () => ({
  loadOverlays: overlayState.load,
  sessionForExternalOutput: (session: ReplaySession) => session,
  sessionWithEffectiveContent: overlayState.apply,
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

function delayedQuickShareRequest(path: string, payload: unknown) {
  let release!: () => void;
  let markRead!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) return;
      sent = true;
      markRead();
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  });
  const request = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, readStarted, release };
}

beforeEach(() => {
  quickShareState.create.mockReset();
  quickShareState.resolve = null;
  overlayState.load.mockReset();
  overlayState.load.mockResolvedValue({ version: 1, overlays: [] });
  overlayState.apply.mockReset();
  overlayState.apply.mockImplementation((session: ReplaySession) => session);
  quickShareState.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        quickShareState.resolve = resolve;
      }),
  );
});

describe("Quick Share routes", () => {
  it("checks status from the in-memory share registry without reloading the replay", async () => {
    const app = new Hono();
    const loadSession = vi.fn(async () => replay());
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession,
    });

    const response = await app.request("/api/share/quick?slug=session-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: false });
    expect(loadSession).not.toHaveBeenCalled();
  });

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
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [{ id: "viewer-1", name: "Blue Otter" }],
      stop: vi.fn(async () => {}),
    });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const firstBody = await firstResponse.json();
    expect(firstBody).toEqual(await secondResponse.json());
    expect(firstBody).toMatchObject({
      active: true,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: [{ id: "viewer-1", name: "Blue Otter" }],
    });
    expect(quickShareState.create).toHaveBeenCalledTimes(1);
  });

  it("uses a supplied current replay snapshot for Quick Share", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });
    const current = { ...replay(), annotations: [{ id: "current" }] } as ReplaySession;
    quickShareState.create.mockResolvedValue({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop: vi.fn(async () => {}),
    });

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replay: current }),
    });
    expect(response.status).toBe(200);
    expect(quickShareState.create).toHaveBeenCalledWith(
      expect.objectContaining({ annotations: [{ id: "current" }] }),
      expect.anything(),
    );
  });

  it("uses canonical overlaid scenes while taking current annotations from the snapshot", async () => {
    const app = new Hono();
    const canonical = replay();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => canonical),
    });
    overlayState.apply.mockImplementation(
      (session: ReplaySession) =>
        ({
          ...session,
          scenes: [
            {
              type: "user-prompt",
              content: `redacted:${session.scenes[0]?.content ?? ""}`,
            },
          ],
        }) as ReplaySession,
    );
    const supplied = {
      ...replay(),
      scenes: [{ type: "user-prompt", content: "client-unredacted-secret" }],
      annotations: [{ id: "current" }],
    } as ReplaySession;
    quickShareState.create.mockResolvedValue({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop: vi.fn(async () => {}),
    });

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replay: supplied }),
    });

    expect(response.status).toBe(200);
    expect(overlayState.load).toHaveBeenCalledWith("/tmp/vibe-replay-test", "session-1", undefined);
    expect(quickShareState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scenes: [{ type: "user-prompt", content: "redacted:hello" }],
        annotations: [{ id: "current" }],
      }),
      expect.anything(),
    );
  });

  it("rejects malformed nonblank JSON instead of falling back to the stored replay", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"replay":',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid Quick Share request" });
    expect(quickShareState.create).not.toHaveBeenCalled();
  });

  it("accepts an SSH snapshot whose storage slug differs from its source slug", async () => {
    const app = new Hono();
    const remote = {
      ...replay(),
      meta: {
        ...replay().meta,
        slug: "provider-source-slug",
        location: { kind: "ssh", id: "remote-dev" },
      },
    } as ReplaySession;
    const loadSession = vi.fn(async () => remote);
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession,
    });
    quickShareState.create.mockResolvedValue({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop: vi.fn(async () => {}),
    });

    const response = await app.request(
      "/api/share/quick?slug=provider-source-slug--ssh-scoped--id-session&targetId=remote-dev",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replay: remote }),
      },
    );

    expect(response.status).toBe(200);
    expect(loadSession).toHaveBeenCalledWith(
      "provider-source-slug--ssh-scoped--id-session",
      "remote-dev",
    );
  });

  it("rejects a supplied snapshot for a different canonical session", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });
    const wrong = {
      ...replay(),
      meta: { ...replay().meta, sessionId: "other-session" },
    } as ReplaySession;

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replay: wrong }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "quick share replay does not match requested session",
    });
    expect(quickShareState.create).not.toHaveBeenCalled();
  });

  it("rejects a supplied replay snapshot without required identity metadata", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replay: {} }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid Quick Share replay snapshot" });
    expect(quickShareState.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized Quick Share request before JSON parsing", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const response = await app.request("/api/share/quick?slug=session-1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(11 * 1024 * 1024),
      },
      body: "{}",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "Quick Share request is too large" });
    expect(quickShareState.create).not.toHaveBeenCalled();
  });

  it("cancels an in-flight share when DELETE wins the race", async () => {
    const stop = vi.fn(async () => {});
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const createResponse = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(1));
    const deleteResponse = app.request("/api/share/quick?slug=session-1", { method: "DELETE" });

    quickShareState.resolve!({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop,
    });

    expect((await createResponse).status).toBe(500);
    expect((await deleteResponse).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await (await app.request("/api/share/quick?slug=session-1")).json()).toEqual({
      active: false,
    });
  });

  it("does not reuse a pre-delete creation for a post-delete POST", async () => {
    const resolves: Array<(value: unknown) => void> = [];
    quickShareState.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolves.push(resolve);
        }),
    );
    const firstStop = vi.fn(async () => {});
    const secondStop = vi.fn(async () => {});
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const firstPost = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(1));

    // DELETE advances the generation but waits for the old creation to
    // settle. A new POST arriving meanwhile must start its own generation.
    const deleting = app.request("/api/share/quick?slug=session-1", { method: "DELETE" });
    await Promise.resolve();
    const secondPost = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(2));

    resolves[0]!({
      url: "https://vibe-replay.com/share/old#key",
      boxId: "old",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop: firstStop,
    });
    resolves[1]!({
      url: "https://vibe-replay.com/share/new#key",
      boxId: "new",
      sizeBytes: 456,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:01.000Z",
      viewers: () => [],
      stop: secondStop,
    });

    expect((await firstPost).status).toBe(500);
    expect((await deleting).status).toBe(200);
    expect((await secondPost).status).toBe(200);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();
    expect(await (await app.request("/api/share/quick?slug=session-1")).json()).toMatchObject({
      active: true,
      url: "https://vibe-replay.com/share/new#key",
      sizeBytes: 456,
    });
  });

  it("does not let a pre-delete body read return a newer share", async () => {
    const app = new Hono();
    registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });
    const delayed = delayedQuickShareRequest("/api/share/quick?slug=session-1", {
      replay: replay(),
    });
    const stalePost = app.request(delayed.request);
    await delayed.readStarted;

    expect(
      (await app.request("/api/share/quick?slug=session-1", { method: "DELETE" })).status,
    ).toBe(200);
    quickShareState.create.mockResolvedValue({
      url: "https://vibe-replay.com/share/new#key",
      boxId: "new",
      sizeBytes: 456,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:01.000Z",
      viewers: () => [],
      stop: vi.fn(async () => {}),
    });
    expect((await app.request("/api/share/quick?slug=session-1", { method: "POST" })).status).toBe(
      200,
    );

    delayed.release();
    expect((await stalePost).status).toBe(409);
    expect(await (await app.request("/api/share/quick?slug=session-1")).json()).toMatchObject({
      active: true,
      url: "https://vibe-replay.com/share/new#key",
    });
    expect(quickShareState.create).toHaveBeenCalledTimes(1);
  });

  it("does not start Quick Share after shutdown finishes during a body read", async () => {
    const app = new Hono();
    const routes = registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });
    const delayed = delayedQuickShareRequest("/api/share/quick?slug=session-1", {
      replay: replay(),
    });
    const stalePost = app.request(delayed.request);
    await delayed.readStarted;

    await routes.stopQuickShares();
    delayed.release();

    expect((await stalePost).status).toBe(503);
    expect(quickShareState.create).not.toHaveBeenCalled();
  });

  it("stops active shares during server cleanup", async () => {
    const stop = vi.fn(async () => {});
    quickShareState.create.mockResolvedValue({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop,
    });

    const app = new Hono();
    const routes = registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    expect((await app.request("/api/share/quick?slug=session-1", { method: "POST" })).status).toBe(
      200,
    );
    await routes.stopQuickShares();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await (await app.request("/api/share/quick?slug=session-1")).json()).toEqual({
      active: false,
    });
    expect((await app.request("/api/share/quick?slug=session-1", { method: "POST" })).status).toBe(
      503,
    );
  });

  it("waits for in-flight share creation during server cleanup", async () => {
    const stop = vi.fn(async () => {});
    const app = new Hono();
    const routes = registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const createResponse = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(1));

    let cleanupDone = false;
    const cleanup = routes.stopQuickShares().then(() => {
      cleanupDone = true;
    });
    await Promise.resolve();
    expect(cleanupDone).toBe(false);

    quickShareState.resolve!({
      url: "https://vibe-replay.com/share/box#key",
      boxId: "box",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop,
    });

    expect((await createResponse).status).toBe(500);
    await cleanup;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("waits for superseded in-flight creations during server cleanup", async () => {
    const resolves: Array<(value: unknown) => void> = [];
    quickShareState.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolves.push(resolve);
        }),
    );
    const firstStop = vi.fn(async () => {});
    const secondStop = vi.fn(async () => {});
    const app = new Hono();
    const routes = registerSessionOutputRoutes(app, {
      baseDir: "/tmp/vibe-replay-test",
      loadSession: vi.fn(async () => replay()),
    });

    const firstPost = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(1));
    const deleting = app.request("/api/share/quick?slug=session-1", { method: "DELETE" });
    await Promise.resolve();
    const secondPost = app.request("/api/share/quick?slug=session-1", { method: "POST" });
    await vi.waitFor(() => expect(quickShareState.create).toHaveBeenCalledTimes(2));

    let cleanupDone = false;
    const cleanup = routes.stopQuickShares().then(() => {
      cleanupDone = true;
    });
    await Promise.resolve();
    expect(cleanupDone).toBe(false);

    resolves[1]!({
      url: "https://vibe-replay.com/share/new#key",
      boxId: "new",
      sizeBytes: 456,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:01.000Z",
      viewers: () => [],
      stop: secondStop,
    });
    await Promise.resolve();
    expect(cleanupDone).toBe(false);

    resolves[0]!({
      url: "https://vibe-replay.com/share/old#key",
      boxId: "old",
      sizeBytes: 123,
      maxBytes: 10 * 1024 * 1024,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: () => [],
      stop: firstStop,
    });

    expect((await firstPost).status).toBe(500);
    expect((await secondPost).status).toBe(500);
    expect((await deleting).status).toBe(200);
    await cleanup;
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
    expect(cleanupDone).toBe(true);
  });
});
