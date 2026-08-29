// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationActions, AiProviderInfo } from "../../hooks/useAnnotations";
import type { OverlayActions } from "../../hooks/useOverlays";
import AiStudioPanel from "../AiStudioPanel";

function provider(overrides: Partial<AiProviderInfo> = {}): AiProviderInfo {
  return {
    id: "openai",
    name: "OpenAI",
    configured: true,
    authType: "api_key",
    authSource: "stored credential",
    authMethods: [{ type: "api_key", label: "OpenAI API key", subscription: false }],
    models: [
      {
        id: "gpt-test",
        name: "GPT Test",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
      },
    ],
    ...overrides,
  };
}

function makeActions(
  providers: AiProviderInfo[],
  overrides: Partial<AnnotationActions> = {},
): { annotationActions: AnnotationActions; overlayActions: OverlayActions } {
  const annotationActions = {
    annotations: [],
    annotatedScenes: new Set<number>(),
    annotationCounts: new Map<number, number>(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    hasUnsaved: false,
    canSaveHtml: false,
    downloadHtml: vi.fn(),
    downloadJson: vi.fn(),
    publishGist: null,
    exportHtml: null,
    exportGithub: null,
    gistPublishing: false,
    htmlExporting: false,
    githubExporting: false,
    aiProviders: providers,
    aiProviderId: providers[0]?.id || null,
    aiModelId: providers[0]?.models[0]?.id || null,
    setAiProviderId: vi.fn(),
    setAiModelId: vi.fn(),
    refreshAiProviders: vi.fn(async () => {}),
    authenticateAiProvider: vi.fn(async () => {}),
    cancelAiAuthentication: vi.fn(),
    logoutAiProvider: vi.fn(async () => {}),
    aiProvidersLoading: false,
    aiProvidersError: null,
    defaultAiProviderId: null,
    defaultAiModelId: null,
    saveAiSelectionAsDefault: vi.fn(),
    runAiCoach: null,
    cancelAiCoach: null,
    aiCoachRunning: false,
    ...overrides,
  } as unknown as AnnotationActions;

  const overlayActions = {
    overlays: { version: 1, overlays: [] },
    effectiveSession: {} as OverlayActions["effectiveSession"],
    getEffectiveContent: vi.fn(),
    hasOverlay: vi.fn(),
    getOverlays: vi.fn(),
    overlayCount: 0,
    setOverlays: vi.fn(),
    revertOverlay: vi.fn(),
    revertSceneOverlays: vi.fn(),
    revertAll: vi.fn(),
    updateOverlay: vi.fn(),
    showOriginal: new Set<number>(),
    toggleOriginal: vi.fn(),
    showAllOriginals: false,
    toggleAllOriginals: vi.fn(),
    studioProviders: providers,
    studioProviderId: providers[0]?.id || null,
    studioModelId: providers[0]?.models[0]?.id || null,
    setStudioProviderId: vi.fn(),
    setStudioModelId: vi.fn(),
    refreshStudioProviders: vi.fn(async () => {}),
    translating: false,
    toningDown: false,
    cancelStudio: null,
    runTranslate: null,
    runTone: null,
  } as unknown as OverlayActions;

  return { annotationActions, overlayActions };
}

afterEach(() => cleanup());

describe("AiStudioPanel", () => {
  it("shows subscription setup without exposing a CLI dependency", () => {
    const actions = makeActions([
      provider({
        id: "openai-codex",
        name: "OpenAI Codex",
        configured: false,
        authType: undefined,
        authMethods: [
          {
            type: "oauth",
            label: "OpenAI (ChatGPT Plus/Pro)",
            subscription: true,
          },
        ],
      }),
    ]);

    render(<AiStudioPanel {...actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("OpenAI Codex")).toBeDefined();
    expect(screen.getByText("not configured")).toBeDefined();
    expect(screen.getByRole("button", { name: "Sign in with provider" })).toBeDefined();
    expect(screen.queryByText("claude -p")).toBeNull();
    expect(screen.queryByText("opencode run")).toBeNull();
  });

  it("saves an API key through the provider auth action", async () => {
    const authenticate = vi.fn(async () => {});
    const actions = makeActions([provider()], {
      authenticateAiProvider: authenticate,
      runAiCoach: vi.fn(async () => ({
        score: 7,
        itemCount: 1,
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-test",
        authType: "api_key",
        authSubscription: false,
      })),
    });

    render(<AiStudioPanel {...actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("AI API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(authenticate).toHaveBeenCalledWith("openai", "api_key", "sk-test"));
  });

  it("offers cancellation while provider authentication is pending", async () => {
    let rejectAuthentication!: (reason: unknown) => void;
    const authenticate = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAuthentication = reject;
        }),
    );
    const cancel = vi.fn(() => rejectAuthentication(new DOMException("Aborted", "AbortError")));
    const actions = makeActions(
      [
        provider({
          configured: false,
          authType: undefined,
          authSource: undefined,
          authMethods: [{ type: "api_key", label: "OpenAI API key", subscription: false }],
        }),
      ],
      { authenticateAiProvider: authenticate, cancelAiAuthentication: cancel },
    );

    render(<AiStudioPanel {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("AI API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(authenticate).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save key" })).toBeDefined());
  });

  it("configures an OpenAI-compatible proxy from the setup form", async () => {
    const configure = vi.fn(async () => {});
    const actions = makeActions([provider()], {
      configureAiCustomProvider: configure,
    });

    render(<AiStudioPanel {...actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("Custom AI provider name"), {
      target: { value: "Local LiteLLM" },
    });
    fireEvent.change(screen.getByLabelText("Custom AI endpoint"), {
      target: { value: "http://127.0.0.1:58788/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    await waitFor(() =>
      expect(configure).toHaveBeenCalledWith({
        name: "Local LiteLLM",
        baseUrl: "http://127.0.0.1:58788/v1",
      }),
    );
  });

  it("filters the model picker and saves the selected model as the default", async () => {
    const saveDefault = vi.fn();
    const actions = makeActions([provider()], { saveAiSelectionAsDefault: saveDefault });

    render(<AiStudioPanel {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "AI model" }));
    fireEvent.change(screen.getByLabelText("Filter AI models"), { target: { value: "gpt-test" } });

    expect(screen.getByRole("button", { name: /GPT Test/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /GPT Test/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set default" }));

    expect(saveDefault).toHaveBeenCalledTimes(1);
  });

  it("closes the model picker before the provider modal on Escape", () => {
    const actions = makeActions([provider()]);

    render(<AiStudioPanel {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "AI model" }));
    fireEvent.keyDown(screen.getByLabelText("Filter AI models"), { key: "Escape" });

    expect(screen.queryByLabelText("Filter AI models")).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can open the full Settings page from AI Studio", () => {
    const actions = makeActions([provider()]);

    render(<AiStudioPanel {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("view")).toBe("dashboard");
    expect(params.get("tab")).toBe("settings");
    window.history.replaceState({}, "", "/");
  });
});
