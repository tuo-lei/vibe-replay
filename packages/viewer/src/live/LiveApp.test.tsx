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
});

beforeEach(stubBrowserAPIs);

const sessions: RelaySessionSummary[] = [
  {
    provider: "muse",
    sessionId: "sess-1",
    title: "First session",
    project: "/tmp/proj",
    timestamp: "2026-09-19T19:00:00.000Z",
    promptCount: 3,
  },
  {
    provider: "codex",
    sessionId: "sess-2",
    project: "/tmp/other",
    timestamp: "2026-09-19T18:00:00.000Z",
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
    expect(screen.getByText("muse")).toBeTruthy();
    expect(screen.getByText("3 prompts")).toBeTruthy();
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
    render(<LiveApp createClient={(boxId) => LiveClient.connect(boxId)} pathname={PATH} />);
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

  it("does not reconnect when displaced by another viewer (1000/replaced)", async () => {
    let disconnectHandler: ((info: { code: number; reason: string }) => void) | undefined;
    const fake = makeFake({
      onDisconnect: (h) => {
        disconnectHandler = h;
        return () => {};
      },
    });
    const createClient = vi.fn().mockResolvedValue(fake);
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText("First session");

    // The same link was opened elsewhere; the relay displaced this viewer.
    disconnectHandler?.({ code: 1000, reason: "replaced" });

    // No reconnect attempt — reconnecting would evict the other side back
    // and forth. The view goes terminal with an explanatory message.
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/opened in another tab or device/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(createClient).toHaveBeenCalledTimes(1);
  }, 25000);

  it("fails fast when the relay displaces the viewer during the initial list", async () => {
    // A second viewer opened the same link while this one was still listing:
    // the relay closed our socket with 1000/"replaced" and the pending list()
    // rejects with "replaced" instead of a generic "disconnected".
    const createClient = vi
      .fn()
      .mockResolvedValue(makeFake({ list: () => Promise.reject(new Error("replaced")) }));
    render(<LiveApp createClient={createClient} pathname={PATH} />);
    await screen.findByText(/opened in another tab/);
    // No retry war against the other viewer: exactly one connect attempt.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

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
});
