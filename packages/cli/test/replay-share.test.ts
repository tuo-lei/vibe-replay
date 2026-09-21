import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../src/types.js";

const relayState = vi.hoisted(() => ({
  options: null as null | {
    handleCommand: (
      message: Record<string, unknown>,
      via?: string,
    ) => Promise<Record<string, unknown>>;
  },
  create: vi.fn(),
  stop: vi.fn(async () => {}),
  ready: Promise.resolve() as Promise<void>,
}));

vi.mock("../src/relay-host.js", () => ({
  DEFAULT_RELAY_ORIGIN: "https://vibe-replay.com",
  createRelayHost: relayState.create.mockImplementation(async (options) => {
    relayState.options = options;
    return {
      boxId: "abcdefghijklmnopqrstuv",
      shareUrl:
        "https://vibe-replay.com/share/abcdefghijklmnopqrstuv#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
      ready: relayState.ready,
      stop: relayState.stop,
    };
  }),
}));

const { QUICK_SHARE_MAX_BYTES, QuickShareTooLargeError, createQuickReplayShare } =
  await import("../src/replay-share.js");

function replay(content = "hello"): ReplaySession {
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
    scenes: [{ type: "user-prompt", content }],
  } as ReplaySession;
}

beforeEach(() => {
  relayState.options = null;
  relayState.create.mockClear();
  relayState.stop.mockClear();
  relayState.ready = Promise.resolve();
});

describe("Quick Replay Share", () => {
  it("exposes only the single replay and ping commands", async () => {
    const session = replay();
    const share = await createQuickReplayShare(session);
    const handle = relayState.options?.handleCommand;
    expect(handle).toBeTypeOf("function");

    await expect(handle!({ seq: 1, cmd: "get-replay" })).resolves.toEqual({
      seq: 1,
      ok: true,
      data: { replay: session },
    });
    await expect(handle!({ seq: 2, cmd: "ping" })).resolves.toMatchObject({
      seq: 2,
      ok: true,
    });
    await expect(handle!({ seq: 3, cmd: "list" })).resolves.toEqual({
      seq: 3,
      ok: false,
      error: "unknown command: list",
    });

    expect(share.url).toContain("/share/");
    expect(share.maxBytes).toBe(10 * 1024 * 1024);
  });

  it("rejects an oversized replay before opening a relay connection", async () => {
    const session = replay("x".repeat(QUICK_SHARE_MAX_BYTES + 1));
    await expect(createQuickReplayShare(session)).rejects.toBeInstanceOf(QuickShareTooLargeError);
    expect(relayState.create).not.toHaveBeenCalled();
  });

  it("stops the relay host when startup readiness fails", async () => {
    relayState.ready = Promise.reject(new Error("relay startup failed"));
    await expect(createQuickReplayShare(replay())).rejects.toThrow("relay startup failed");
    expect(relayState.stop).toHaveBeenCalledTimes(1);
  });
});
