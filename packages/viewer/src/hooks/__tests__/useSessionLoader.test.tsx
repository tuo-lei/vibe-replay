// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplaySession } from "../../types";
import { useSessionLoader } from "../useSessionLoader";

const win = window as unknown as {
  __VIBE_REPLAY_DATA__?: ReplaySession;
  __VIBE_REPLAY_EDITOR__?: boolean;
};

// A minimal stand-in — the loader passes the object through unchanged and the
// tests only assert status/mode, never the session shape.
const fakeSession: ReplaySession = {
  meta: {
    sessionId: "session-1",
    slug: "session-1",
    provider: "claude-code",
    startTime: "2026-01-01T00:00:00.000Z",
    cwd: "~/project",
    project: "~/project",
    stats: { sceneCount: 0, userPrompts: 0, toolCalls: 0 },
  },
  scenes: [],
};

function setSearch(search: string) {
  window.history.replaceState({}, "", search || "/");
}

afterEach(() => {
  cleanup();
  win.__VIBE_REPLAY_DATA__ = undefined;
  win.__VIBE_REPLAY_EDITOR__ = undefined;
  setSearch("/");
});

describe("useSessionLoader", () => {
  it("loads embedded data injected by the CLI", async () => {
    win.__VIBE_REPLAY_DATA__ = fakeSession;
    const { result } = renderHook(() => useSessionLoader());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("embedded");
    expect(result.current.session).toBe(fakeSession);
  });

  it("shows the dashboard when there is no data source", async () => {
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("dashboard"));
  });

  it("shows the dashboard for ?view=dashboard in editor mode", async () => {
    win.__VIBE_REPLAY_EDITOR__ = true;
    setSearch("?view=dashboard");
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("dashboard"));
  });

  it("errors on a malformed cloud replay id", async () => {
    setSearch("?cloud=not-valid!");
    const { result } = renderHook(() => useSessionLoader());

    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status !== "error") throw new Error("unreachable");
    expect(result.current.message).toMatch(/invalid cloud replay id/i);
  });

  it("errors on a malformed gist id", async () => {
    setSearch("?gist=xyz");
    const { result } = renderHook(() => useSessionLoader());

    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status !== "error") throw new Error("unreachable");
    expect(result.current.message).toMatch(/invalid gist id/i);
  });

  it("prefers embedded data over URL parameters", async () => {
    win.__VIBE_REPLAY_DATA__ = fakeSession;
    setSearch("?cloud=not-valid!");
    const { result } = renderHook(() => useSessionLoader());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("embedded");
  });

  it("errors on invalid SSH targetId in editor mode", async () => {
    win.__VIBE_REPLAY_EDITOR__ = true;
    setSearch("?session=my-slug&targetId=bad!id");
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status !== "error") throw new Error("unreachable");
    expect(result.current.message).toMatch(/invalid ssh source/i);
  });

  it("loads via ?url in readonly mode", async () => {
    const url = "https://example.com/replay.json";
    setSearch(`?url=${encodeURIComponent(url)}`);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(fakeSession)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("readonly");
    expect(fetchMock).toHaveBeenCalledWith(url);
  });

  it("loads via ?file in dev mode", async () => {
    setSearch("?file=/replay.json");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fakeSession),
      text: () => Promise.resolve(JSON.stringify(fakeSession)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("embedded");
  });

  it("errors when ?file fetch fails", async () => {
    setSearch("?file=/missing.json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("loads specific session by slug in editor mode", async () => {
    win.__VIBE_REPLAY_EDITOR__ = true;
    setSearch("?session=my-slug");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fakeSession),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("editor");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/session?slug=my-slug"));
  });

  it("does not let a stale session response overwrite a newer navigation", async () => {
    win.__VIBE_REPLAY_EDITOR__ = true;
    setSearch("?session=slow-session");
    let resolveSlow!: (session: ReplaySession) => void;
    const slowJson = new Promise<ReplaySession>((resolve) => {
      resolveSlow = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => slowJson,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setSearch("?view=dashboard");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(result.current.status).toBe("dashboard"));

    resolveSlow(fakeSession);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.status).toBe("dashboard");
  });

  it("ignores ?live when an explicit ?session is present in editor mode (stale URL guard)", async () => {
    win.__VIBE_REPLAY_EDITOR__ = true;
    // ?live=1&provider=claude-code&sessionId=abc would normally start SSE,
    // but ?session=foo takes precedence and should load that replay instead.
    setSearch("?live=1&provider=claude-code&sessionId=abc&session=my-slug");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(fakeSession),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.mode).toBe("editor");
  });
});

describe("readLiveParams guards (via editor live precedence)", () => {
  beforeEach(() => {
    win.__VIBE_REPLAY_EDITOR__ = true;
  });

  it("does not start live stream when ?view=dashboard is present (even with live params)", async () => {
    // Should show dashboard, not error or SSE
    setSearch("?live=1&provider=claude-code&sessionId=abc&view=dashboard");
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("dashboard"));
  });

  it("does not start live stream when provider contains invalid chars", async () => {
    // Invalid provider => readLiveParams returns null => falls through to dashboard
    setSearch("?live=1&provider=bad!provider&sessionId=abc");
    const { result } = renderHook(() => useSessionLoader());
    await waitFor(() => expect(result.current.status).toBe("dashboard"));
  });
});
