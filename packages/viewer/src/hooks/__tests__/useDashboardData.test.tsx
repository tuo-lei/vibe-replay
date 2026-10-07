// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardData } from "../useDashboardData";

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    MockEventSource.instances.push(this);
  }
  send(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
const source = {
  provider: "codex",
  slug: "session-a",
  project: "~/project",
  timestamp: "2026-10-06T00:00:00Z",
  firstPrompt: "Improve discovery",
  fileSize: 10,
  lineCount: 1,
  filePaths: [],
  existingReplay: null,
};
let sourceCache: unknown;
let replayCache: unknown;
let fallback: unknown;
let freshReplays: unknown;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sourceCache = null;
  replayCache = null;
  fallback = { sessions: [source] };
  freshReplays = [];
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  fetchMock = vi.fn(async (url: string) => {
    const data =
      url === "/api/sources/cached"
        ? sourceCache
        : url === "/api/sessions/cached"
          ? replayCache
          : url === "/api/sources/enrichment-status"
            ? { running: false }
            : url === "/api/sources"
              ? fallback
              : freshReplays;
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function stream() {
  await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
  return MockEventSource.instances.at(-1)!;
}
describe("dashboard cold start", () => {
  it("keeps replay-only cache behind the gate and reveals real discovery progress", async () => {
    replayCache = { sessions: [{ slug: "saved-replay" }], cachedAt: new Date().toISOString() };
    const { result } = renderHook(() => useDashboardData());
    const es = await stream();
    expect(result.current.replays).toHaveLength(1);
    expect(result.current.startupActive).toBe(true);
    const progress = {
      type: "progress",
      phase: "preparing",
      scanned: 3,
      total: 1,
      prepared: 0,
      providers: ["codex"],
      previews: [source],
    };
    act(() => es.send(progress));
    expect(result.current.discoveryProgress).toEqual(progress);
    act(() => es.send({ type: "complete", sessions: [source], failedProviders: [] }));
    await waitFor(() => expect(result.current.startupActive).toBe(false));
    expect(result.current.sources).toEqual([source]);
    expect(es.close).toHaveBeenCalled();
  });
  it.each([{ sessions: [] }, { sessions: [source] }])(
    "bypasses startup for a fresh valid source snapshot (%j)",
    async ({ sessions }) => {
      sourceCache = { sessions, cachedAt: new Date().toISOString() };
      const { result } = renderHook(() => useDashboardData());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.startupActive).toBe(false);
      expect(MockEventSource.instances).toHaveLength(0);
    },
  );
  it("does not treat an invalid timestamp as an empty warm snapshot", async () => {
    sourceCache = { sessions: [], cachedAt: "invalid" };
    const { result } = renderHook(() => useDashboardData());
    await stream();
    expect(result.current.startupActive).toBe(true);
  });
  it("keeps empty discovery explicit and lets users open the dashboard", async () => {
    const { result } = renderHook(() => useDashboardData());
    const es = await stream();
    act(() => es.send({ type: "complete", sessions: [], failedProviders: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.startupActive).toBe(true);
    act(() => result.current.dismissStartup());
    expect(result.current.startupActive).toBe(false);
  });
  it("offers partial results explicitly and retries without leaving an old stream", async () => {
    const { result } = renderHook(() => useDashboardData());
    const es = await stream();
    act(() => es.send({ type: "complete", sessions: [source], failedProviders: ["cursor"] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.startupActive).toBe(true);
    expect(result.current.failedProviders).toEqual(["cursor"]);
    act(() => result.current.retry());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    act(() =>
      MockEventSource.instances[1].send({
        type: "complete",
        sessions: [source],
        failedProviders: [],
      }),
    );
    await waitFor(() => expect(result.current.startupActive).toBe(false));
    expect(es.onmessage).toBeNull();
  });
  it("falls back to REST after SSE fails and preserves failure coverage", async () => {
    fallback = { sessions: [source], failedProviders: ["cursor"] };
    const { result } = renderHook(() => useDashboardData());
    const es = await stream();
    act(() => es.onerror?.());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources).toEqual([source]);
    expect(result.current.failedProviders).toEqual(["cursor"]);
    expect(result.current.startupActive).toBe(true);
  });
  it("keeps freshly loaded replays usable after all sources fail", async () => {
    freshReplays = [{ slug: "saved-replay" }];
    const { result } = renderHook(() => useDashboardData());
    const es = await stream();
    act(() => es.send({ type: "complete", sessions: [], failedProviders: ["cursor"] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.replays).toEqual(freshReplays);
    expect(result.current.startupActive).toBe(true);
    act(() => result.current.dismissStartup());
    expect(result.current.startupActive).toBe(false);
    expect(result.current.replays).toEqual(freshReplays);
  });
  it("closes the stream and detaches handlers when leaving Home", async () => {
    const { unmount } = renderHook(() => useDashboardData());
    const es = await stream();
    unmount();
    expect(es.close).toHaveBeenCalled();
    expect(es.onmessage).toBeNull();
    expect(es.onerror).toBeNull();
  });
});

it.each([{ nextSources: [] }, { nextSources: [source] }])(
  "forces manual discovery past a freshly cached empty catalog (%j)",
  async ({ nextSources }) => {
    const { result } = renderHook(() => useDashboardData());
    const first = await stream();
    act(() => first.send({ type: "complete", sessions: [], failedProviders: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    sourceCache = { sessions: [], cachedAt: new Date().toISOString() };
    replayCache = { sessions: [], cachedAt: new Date().toISOString() };
    act(() => result.current.retry());
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(result.current.startupActive).toBe(true);
    expect(result.current.loadingSources).toBe(true);
    act(() =>
      MockEventSource.instances[1].send({
        type: "complete",
        sessions: nextSources,
        failedProviders: [],
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources).toEqual(nextSources);
    expect(result.current.startupActive).toBe(nextSources.length === 0);
  },
);
