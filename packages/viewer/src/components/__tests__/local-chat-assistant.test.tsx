// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalChatAssistant from "../LocalChatAssistant";

const providerSettings = vi.hoisted(() => ({
  aiProviders: [
    {
      id: "openai",
      name: "OpenAI",
      configured: true,
      authMethods: [],
      models: [
        {
          id: "test-model",
          name: "Test model",
          api: "openai-responses",
          reasoning: false,
          input: ["text"],
        },
      ],
    },
  ],
  aiProviderId: "openai",
  aiModelId: "test-model",
  setAiProviderId: vi.fn(),
  setAiModelId: vi.fn(),
  refreshAiProviders: vi.fn(async () => {}),
  authenticateAiProvider: null,
  cancelAiAuthentication: null,
  logoutAiProvider: null,
  configureAiCustomProvider: null,
  removeAiCustomProvider: null,
  aiProvidersLoading: false,
  aiProvidersError: null,
  defaultAiProviderId: null,
  defaultAiModelId: null,
  saveAiSelectionAsDefault: vi.fn(),
}));

vi.mock("../../hooks/useAiProviderSettings", () => ({
  useAiProviderSettings: () => providerSettings,
}));

function settingsResponse(remoteSources: unknown[]) {
  return {
    ok: true,
    json: async () => ({ remoteSources }),
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/settings")) return settingsResponse([]);
      throw new Error(`Unexpected request: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("LocalChatAssistant SSH consent UI", () => {
  it("does not show SSH consent when no SSH source is configured", async () => {
    render(<LocalChatAssistant context={{ mode: "dashboard" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Replay" }));

    await waitFor(() => expect(screen.getByText("What would you like to find?")).toBeDefined());
    expect(screen.queryByText(/SSH session data is hidden/)).toBeNull();
    expect(screen.queryByText(/Allow SSH session metadata and content/)).toBeNull();
  });

  it("shows a Settings link when an SSH source exists but consent is off", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      async () => settingsResponse([{ id: "remote-dev" }]) as unknown as Response,
    );
    render(<LocalChatAssistant context={{ mode: "dashboard" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Replay" }));

    await waitFor(() =>
      expect(
        screen.getByText("SSH session data is hidden from Ask Replay until enabled in Settings."),
      ).toBeDefined(),
    );
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeDefined();
  });
});
