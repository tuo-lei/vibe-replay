// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveApp from "./LiveApp";
import { stubBrowserAPIs } from "../test-utils/jsdom-stubs";
import type { Scene } from "../types";
import type { LiveRelay, RelaySessionSummary } from "./protocol";

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
});
