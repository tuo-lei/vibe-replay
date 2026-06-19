// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplaySession } from "../../types";
import { useSessionLoader } from "../useSessionLoader";

const win = window as unknown as {
  __VIBE_REPLAY_DATA__?: ReplaySession;
  __VIBE_REPLAY_EDITOR__?: boolean;
};

// A minimal stand-in — the loader passes the object through unchanged and the
// tests only assert status/mode, never the session shape.
const fakeSession = { scenes: [], meta: {} } as unknown as ReplaySession;

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
});
