// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveApp from "./LiveApp";
import { stubBrowserAPIs } from "../test-utils/jsdom-stubs";
import type { Scene } from "../types";
import type { LiveRelay, RelaySessionSummary, TailEvent } from "./protocol";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.removeItem("vibe-replay:viewer-name");
});

beforeEach(() => {
  stubBrowserAPIs();
  // The mount probe hits /live/:boxId/status: default to a live box so tests
  // exercise the normal flow; individual tests override for the ended path.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "live" }) }),
  );
  // Most tests exercise the connected app; the name gate is covered by its
  // own tests, which clear this first.
  window.localStorage.setItem("vibe-replay:viewer-name", "Tester");
});

const sessions: RelaySessionSummary[] = [
  {
    provider: "muse",
    sessionId: "sess-1",
    title: "First session",
    project: "/tmp/proj",
    timestamp: "2026-09-19T19:00:00.000Z",
    promptCount: 3,
    toolCallCount: 12,
    editCountEst: 4,
    durationMsEst: 2700000,
    compactionCount: 2,
    gitBranch: "feat/live-filters",
    gitRepo: "tuo-lei/vibe-replay",
    model: "claude-sonnet-4-20250514",
    lineCount: 100,
    fileSize: 4096,
  },
  {
    provider: "codex",
    sessionId: "sess-2",
    title: "Second session",
    project: "/tmp/other",
    timestamp: "2026-09-19T18:00:00.000Z",
    lineCount: 50,
    fileSize: 2048,
  },
];

const scenes: Scene[] = [
  { type: "user-prompt", content: "Explain this change" },
  { type: "text-response", content: "Here is the explanation." },
];

function makeFake(overrides: Partial<LiveRelay> = {}): LiveRelay {
  return {
    list: async () => sessions,
    get: async () => ({ scenes, totalScenes: scenes.length, offset: 0 }),
    search: async () => [
      {
        sessionId: "sess-1",
        title: "First session",
        provider: "muse",
        snippet: "…Explain this change…",
      },
    ],
    tail: async () => ({ totalScenes: scenes.length }),
    untail: async () => {},
    onTail: () => () => {},
    onDisconnect: () => () => {},
    onPresence: () => () => {},
    onSessionEnded: () => () => {},
    close: () => {},
    ...overrides,
  };
}

const PATH = "/live/x2KJPqQxznNNftBLSHV5jA";

function renderApp(fake: LiveRelay) {
  return render(<LiveApp createClient={async () => fake} pathname={PATH} />);
}

describe("LiveApp", () => {
  it("lists sessions from the relay", async () => {
    renderApp(makeFake());
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
    expect(screen.getByText("First session")).toBeTruthy();
    // Provider facet chip (shared filter UI with the dashboard).
    expect(screen.getByRole("button", { name: "muse1" })).toBeTruthy();
    // The card's shared activity status row renders exact values.
    const statusRow = screen.getByText("First session").closest("button")!;
    expect(statusRow.textContent).toContain("3 prompts");
    expect(statusRow.textContent).toContain("12 tools");
  });

  it("filters the list by provider facet", async () => {
    renderApp(makeFake());
    await screen.findByText("E2E-encrypted · 2 sessions");
    fireEvent.click(screen.getByRole("button", { name: "muse1" }));
    expect(await screen.findByText("E2E-encrypted · 1 of 2 sessions")).toBeTruthy();
    expect(screen.getByText("First session")).toBeTruthy();
    expect(screen.queryByText("Second session")).toBeNull();
    // Toggling the chip off restores the full list.
    fireEvent.click(screen.getByRole("button", { name: "muse1" }));
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
    expect(screen.getByText("Second session")).toBeTruthy();
  });

  it("filters the list by project and by text", async () => {
    renderApp(makeFake());
    await screen.findByText("E2E-encrypted · 2 sessions");
    fireEvent.change(screen.getByLabelText("Filter by project"), {
      target: { value: "/tmp/other" },
    });
    expect(await screen.findByText("E2E-encrypted · 1 of 2 sessions")).toBeTruthy();
    expect(screen.queryByText("First session")).toBeNull();
    expect(screen.getByText("Second session")).toBeTruthy();
    // Clearing the project select, then filtering by text instead.
    fireEvent.change(screen.getByLabelText("Filter by project"), {
      target: { value: "__all__" },
    });
    fireEvent.change(screen.getByPlaceholderText("Filter list…"), {
      target: { value: "first" },
    });
    expect(await screen.findByText("E2E-encrypted · 1 of 2 sessions")).toBeTruthy();
    expect(screen.getByText("First session")).toBeTruthy();
    expect(screen.queryByText("Second session")).toBeNull();
    // "No sessions match" empty state when nothing matches.
    fireEvent.change(screen.getByPlaceholderText("Filter list…"), {
      target: { value: "zzz-no-match" },
    });
    expect(await screen.findByText("No sessions match the current filters.")).toBeTruthy();
    // Clear all restores everything.
    fireEvent.click(screen.getByText("Clear all"));
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
  });

  it("toggles the list sort order between newest and oldest", async () => {
    renderApp(makeFake());
    await screen.findByText("E2E-encrypted · 2 sessions");
    const order = () => document.body.innerHTML;
    // Shipper sends newest first: sess-1 (19:00) before sess-2 (18:00).
    expect(order().indexOf("First session")).toBeLessThan(order().indexOf("Second session"));
    fireEvent.click(screen.getByTitle("Newest first"));
    expect(await screen.findByTitle("Oldest first")).toBeTruthy();
    expect(order().indexOf("First session")).toBeGreaterThan(order().indexOf("Second session"));
  });

  it("shows discovery estimates with a tilde on the shared status row", async () => {
    renderApp(makeFake());
    await screen.findByText("First session");
    const statusRow = screen.getByText("First session").closest("button")!;
    // durationMsEst / editCountEst are estimates → "~" prefix, like the dashboard.
    expect(statusRow.textContent).toContain("~45m");
    expect(statusRow.textContent).toContain("~4 edits");
    expect(statusRow.textContent).toContain("2 compacts");
    expect(statusRow.textContent).toContain("feat/live-filters");
    expect(statusRow.textContent).toContain("tuo-lei/vibe-replay");
  });

  it("opens a session and renders the transcript via ConversationView", async () => {
    renderApp(makeFake());
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    // Decrypted scenes render through the shared ConversationView UI…
    expect(await screen.findByText("Explain this change")).toBeTruthy();
    expect(await screen.findByText("E2E-encrypted · 2 scenes")).toBeTruthy();
    // …and back returns to the list.
    fireEvent.click(screen.getByText("← All sessions"));
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
  });

  it("searches and opens a hit", async () => {
    renderApp(makeFake());
    await screen.findByText("First session");
    fireEvent.change(screen.getByPlaceholderText("Search sessions…"), {
      target: { value: "relay" },
    });
    fireEvent.click(screen.getByText("Search", { selector: "button" }));
    expect(await screen.findByText("E2E-encrypted · 1 hits")).toBeTruthy();
    expect(screen.getByText("…Explain this change…")).toBeTruthy();
    fireEvent.click(screen.getByText("First session"));
    expect(await screen.findByText("Here is the explanation.")).toBeTruthy();
  });

  it("shows a fatal error for an invalid share path", async () => {
    render(<LiveApp createClient={async () => makeFake()} pathname="/live/nope" />);
    expect(await screen.findByText(/Invalid share URL/)).toBeTruthy();
  });

  it("shows a fatal error when the key is missing", async () => {
    const { LiveClient } = await import("./protocol");
    render(
      <LiveApp createClient={(boxId, name) => LiveClient.connect(boxId, name)} pathname={PATH} />,
    );
    // jsdom has no #fragment key → invalid-share-url
    expect(await screen.findByText(/missing encryption key/)).toBeTruthy();
  });

  it("resumes watch-live from the advanced remote cursor after a tail gap", async () => {
    const getCalls: Array<{ offset: number; limit: number }> = [];
    let tailHandler: ((ev: TailEvent) => void) | undefined;
    const fake = makeFake({
      onTail: (h) => {
        tailHandler = h;
        return () => {};
      },
      get: async (_id, offset, limit) => {
        getCalls.push({ offset, limit });
        return { scenes: [], totalScenes: 0, offset };
      },
      tail: async () => ({ totalScenes: 5 }),
    });
    renderApp(fake);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("E2E-encrypted · 0 scenes");

    // Shipper skipped 3 scenes that were too large to relay.
    act(() => {
      tailHandler?.({ event: "tail-gap", id: "sess-1", skipped: 3 });
    });
    expect(screen.getByText(/3 new scenes were too large/)).toBeTruthy();

    fireEvent.click(screen.getByText("Watch live"));
    await screen.findByText(/live — new turns appear below/);
    // The resume fetch must start at the advanced cursor (0 + 3), not at the
    // rendered array length (0), and page the remaining 2 scenes.
    const resume = getCalls.filter((c) => c.offset === 3);
    expect(resume).toHaveLength(1);
    expect(resume[0].limit).toBe(2);
  });

  it("replays tail events buffered during watch-live catch-up exactly once", async () => {
    let tailHandler: ((ev: TailEvent) => void) | undefined;
    let emitLive = false;
    const liveScene: Scene = { type: "text-response", content: "live scene" };
    const fake = makeFake({
      onTail: (h) => {
        tailHandler = h;
        return () => {};
      },
      get: async (_id, offset, limit) => {
        // A live turn lands while the catch-up page is in flight.
        if (emitLive) {
          emitLive = false;
          tailHandler?.({ event: "tail", id: "sess-1", newScenes: [liveScene] });
        }
        return { scenes: [], totalScenes: 0, offset };
      },
      tail: async () => ({ totalScenes: 3 }),
    });
    renderApp(fake);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("E2E-encrypted · 0 scenes");

    emitLive = true;
    fireEvent.click(screen.getByText("Watch live"));
    await screen.findByText(/live — new turns appear below/);
    // Buffered during catch-up, applied once afterwards — not lost, not duplicated.
    expect(screen.getAllByText("live scene")).toHaveLength(1);
  });

  it("retries the initial connect through a transient shipper outage", async () => {
    const createClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection-error"))
      .mockRejectedValueOnce(new Error("connection-error"))
      .mockResolvedValue(makeFake());
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    // Backoff is 1s then 2s before the third attempt succeeds.
    expect(
      await screen.findByText("E2E-encrypted · 2 sessions", {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(3);
  }, 25000);

  it("reconnects and restores the open session after a mid-session drop", async () => {
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    const fake2 = makeFake();
    const createClient = vi.fn().mockResolvedValueOnce(fake1).mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("Explain this change");

    // The socket drops unexpectedly; the app re-establishes on its own.
    disconnectHandler?.({ code: 1006, reason: "" });
    // The open session's scenes are reloaded on the fresh client.
    expect(await screen.findByText("Explain this change")).toBeTruthy();
    expect(
      await screen.findByText("E2E-encrypted · 2 scenes", {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(2);
  }, 25000);

  it("reconnects through a relay-initiated close (viewers are never displaced)", async () => {
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    const fake2 = makeFake();
    const createClient = vi.fn().mockResolvedValueOnce(fake1).mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");

    // Even a clean 1000 close is treated as transient now: the relay never
    // evicts viewers for opening the same link twice, so reconnecting can't
    // start an eviction war.
    disconnectHandler?.({ code: 1000, reason: "replaced" });
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(2);
  }, 25000);

  it("retries when the initial list fails with a transient drop", async () => {
    // The pending list() rejects with a generic "disconnected" — no special
    // "replaced" case exists anymore — so the app retries with backoff.
    const createClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue(makeFake());
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    expect(
      await screen.findByText("E2E-encrypted · 2 sessions", {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(2);
  }, 25000);

  it("runs another reconnect pass when a drop interrupts the restore", async () => {
    let disconnectHandler1: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler1 = h;
        return () => {};
      },
    });
    let disconnectHandler2: ((info: { code: number; reason: string }) => void) | undefined;
    let getCalls = 0;
    const fake2 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler2 = h;
        return () => {};
      },
      get: async () => {
        getCalls++;
        if (getCalls === 1) {
          // A second drop lands while the first pass is restoring scenes.
          disconnectHandler2?.({ code: 1006, reason: "" });
          throw new Error("disconnected");
        }
        return { scenes, totalScenes: scenes.length, offset: 0 };
      },
    });
    const createClient = vi.fn().mockResolvedValueOnce(fake1).mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("Explain this change");

    disconnectHandler1?.({ code: 1006, reason: "" });

    // Pass 2 runs (a third connect) and completes the restore instead of
    // stranding the page on a terminal error.
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(3));
    await screen.findByText("Explain this change");
    expect(screen.queryByText(/opened in another tab/)).toBeNull();
  }, 25000);

  it("resumes watch-live on the replacement client after a mid-session drop", async () => {
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    const tailCalls2: string[] = [];
    const fake2 = makeFake({
      tail: async (id) => {
        tailCalls2.push(id);
        return { totalScenes: scenes.length };
      },
    });
    const createClient = vi.fn().mockResolvedValueOnce(fake1).mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("Explain this change");
    fireEvent.click(screen.getByText("Watch live"));
    await screen.findByText(/live — new turns appear below/);

    // Socket drops mid-watch; the app re-establishes on its own.
    disconnectHandler?.({ code: 1006, reason: "" });

    // The replacement client picks up the tail subscription for the session…
    await waitFor(() => expect(tailCalls2).toEqual(["sess-1"]));
    // …and the UI is back in watching state once catch-up completes.
    await waitFor(() => expect(screen.getByText("Stop watching")).toBeTruthy());
    expect(createClient).toHaveBeenCalledTimes(2);
  }, 25000);

  it("does not drag the user back into the detail view after they navigated away during an outage", async () => {
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1 = makeFake({
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    // Gate the reconnect's list() so the test can navigate mid-reconnect.
    let releaseList!: () => void;
    const listGate = new Promise<RelaySessionSummary[]>((resolve) => {
      releaseList = () => resolve(sessions);
    });
    const fake2 = makeFake({ list: () => listGate });
    const createClient = vi.fn().mockResolvedValueOnce(fake1).mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");
    fireEvent.click(screen.getByText("First session"));
    await screen.findByText("Explain this change");

    // Socket drops; the reconnect starts but its list() is gated. The user
    // navigates back to the list while the outage is in progress.
    disconnectHandler?.({ code: 1006, reason: "" });
    await screen.findByText("Connecting…");
    fireEvent.click(screen.getByText("← All sessions"));
    // Back on the list view: detail-only content is gone (status still shows
    // the in-flight reconnect).
    await waitFor(() => {
      expect(screen.queryByText("Explain this change")).toBeNull();
      expect(screen.queryByText("← All sessions")).toBeNull();
    });

    // Now let the reconnect finish: the user stays on the list view and is
    // not dragged back into the session they left.
    releaseList();
    expect(
      await screen.findByText("E2E-encrypted · 2 sessions", {}, { timeout: 15000 }),
    ).toBeTruthy();
    expect(screen.queryByText("Explain this change")).toBeNull();
    expect(createClient).toHaveBeenCalledTimes(2);
  }, 25000);

  it("shows the name gate on first visit and remembers the name", async () => {
    window.localStorage.removeItem("vibe-replay:viewer-name");
    const createClient = vi.fn().mockResolvedValue(makeFake());
    render(<LiveApp createClient={createClient} pathname={PATH} />);

    // No stored name: the gate shows and no connection is attempted.
    expect(await screen.findByText("Pick a display name")).toBeTruthy();
    expect(createClient).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("e.g. Lei"), { target: { value: "  Wendy  " } });
    fireEvent.click(screen.getByText("Watch live"));

    // The trimmed name is stored and handed to the relay on connect.
    expect(window.localStorage.getItem("vibe-replay:viewer-name")).toBe("Wendy");
    expect(await screen.findByText("E2E-encrypted · 2 sessions")).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(expect.any(String), "Wendy");
  });

  it("renders the presence roster and keeps it across a reconnect", async () => {
    let presenceHandler:
      | ((viewers: Array<{ vid: string; name: string }>, selfVid: string | null) => void)
      | undefined;
    const fake1 = makeFake({
      onPresence: (h) => {
        presenceHandler = h;
        return () => {};
      },
    });
    let presenceHandler2:
      | ((viewers: Array<{ vid: string; name: string }>, selfVid: string | null) => void)
      | undefined;
    const fake2 = makeFake({
      onPresence: (h) => {
        presenceHandler2 = h;
        return () => {};
      },
    });
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake1WithDisconnect = makeFake({
      onPresence: fake1.onPresence,
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    const createClient = vi
      .fn()
      .mockResolvedValueOnce(fake1WithDisconnect)
      .mockResolvedValue(fake2);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");

    act(() => {
      presenceHandler?.(
        [
          { vid: "v1", name: "Tester" },
          { vid: "v2", name: "Wendy" },
        ],
        "v1",
      );
    });
    expect(await screen.findByText("2 online")).toBeTruthy();

    // Drop and reconnect with the same remembered name: the roster refreshes
    // on the new connection instead of showing the stale one.
    disconnectHandler?.({ code: 1006, reason: "" });
    await waitFor(() => expect(screen.queryByText("2 online")).toBeNull());
    act(() => {
      presenceHandler2?.([{ vid: "v3", name: "Tester" }], "v3");
    });
    expect(await screen.findByText("1 online")).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenNthCalledWith(2, expect.any(String), "Tester");
  });

  it("clicking the roster clears the remembered name and shows the gate", async () => {
    let presenceHandler:
      | ((viewers: Array<{ vid: string; name: string }>, selfVid: string | null) => void)
      | undefined;
    const fake = makeFake({
      onPresence: (h) => {
        presenceHandler = h;
        return () => {};
      },
    });
    renderApp(fake);
    await screen.findByText("First session");
    act(() => {
      presenceHandler?.([{ vid: "v1", name: "Tester" }], "v1");
    });
    expect(await screen.findByText("1 online")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Rename"));
    expect(window.localStorage.getItem("vibe-replay:viewer-name")).toBeNull();
    expect(await screen.findByText("Pick a display name")).toBeTruthy();
  });

  it("shows the ended page (not a retry loop) when the relay kills the box mid-session", async () => {
    let endedHandler: (() => void) | undefined;
    const fake = makeFake({
      onSessionEnded: (h) => {
        endedHandler = h;
        return () => {};
      },
    });
    const createClient = vi.fn().mockResolvedValue(fake);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");

    act(() => {
      endedHandler?.();
    });
    expect(await screen.findByText("This live session has ended")).toBeTruthy();
    expect(screen.getByText(/this link no longer works and will not come back/i)).toBeTruthy();
    // No reconnect is attempted: this box id will never come back.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("shows the ended page without retrying when connect fails with session-ended", async () => {
    const createClient = vi.fn().mockRejectedValue(new Error("session-ended"));
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    expect(await screen.findByText("This live session has ended")).toBeTruthy();
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("shows the ended page before the name gate when the status probe says ended", async () => {
    window.localStorage.removeItem("vibe-replay:viewer-name");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ended" }),
    } as Response);
    const createClient = vi.fn().mockResolvedValue(makeFake());
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    expect(await screen.findByText("This live session has ended")).toBeTruthy();
    expect(screen.queryByText("Pick a display name")).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/live/x2KJPqQxznNNftBLSHV5jA/status"),
      expect.anything(),
    );
  });

  it("renders the name gate in English and explains encryption without product analogies", async () => {
    window.localStorage.removeItem("vibe-replay:viewer-name");
    const { container } = render(
      <LiveApp createClient={vi.fn().mockResolvedValue(makeFake())} pathname={PATH} />,
    );
    await screen.findByText("Pick a display name");
    const gateText = container.textContent ?? "";
    // No Chinese characters anywhere in the gate.
    expect(gateText).not.toMatch(/[\u4e00-\u9fff]/);
    // Direct explanation of the security property, not "like <product>".
    expect(gateText).toMatch(/end-to-end encrypted/i);
    expect(gateText).not.toMatch(/Excalidraw/i);
    expect(screen.getByPlaceholderText("e.g. Lei")).toBeTruthy();
    expect(screen.getByText("Watch live")).toBeTruthy();
  });
});
