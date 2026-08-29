// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiProviderSettings } from "../useAiProviderSettings";

const STORAGE_KEY = "vibe-replay-ai-selection-v1";

const providers = [
  {
    id: "custom-openai",
    name: "Local LiteLLM",
    configured: true,
    authMethods: [],
    custom: { baseUrl: "http://127.0.0.1:58788/v1" },
    models: [
      {
        id: "model-a",
        name: "Model A",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
      },
      {
        id: "model-b",
        name: "Model B",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
      },
    ],
  },
];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ providers, defaultProvider: { id: "custom-openai" } }),
    })),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("useAiProviderSettings", () => {
  it("remembers a manually selected model across remounts", async () => {
    const { result, unmount } = renderHook(() => useAiProviderSettings(true));

    await waitFor(() => expect(result.current.aiModelId).toBe("model-a"));
    act(() => result.current.setAiModelId?.("model-b"));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")).toEqual({
      providerId: "custom-openai",
      modelId: "model-b",
    });
    expect(result.current.defaultAiModelId).toBe("model-b");

    unmount();
    const second = renderHook(() => useAiProviderSettings(true));
    await waitFor(() => expect(second.result.current.aiModelId).toBe("model-b"));
    second.unmount();
  });
});
