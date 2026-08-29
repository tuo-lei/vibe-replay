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

  it("does not let an older refresh replace a newer provider catalog", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse);

    const responseFor = (providerId: string) =>
      new Response(
        JSON.stringify({
          providers: [
            {
              id: providerId,
              name: providerId,
              configured: true,
              authMethods: [],
              models: [
                {
                  id: `${providerId}-model`,
                  name: `${providerId} model`,
                  api: "openai-completions",
                  reasoning: false,
                  input: ["text"],
                },
              ],
            },
          ],
          defaultProvider: { id: providerId },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const { result } = renderHook(() => useAiProviderSettings(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const refresh = result.current.refreshAiProviders;
    if (!refresh) throw new Error("refresh action is unavailable");
    const newerRefresh = refresh();
    await act(async () => {
      resolveSecond(responseFor("provider-b"));
      await newerRefresh;
    });
    await waitFor(() => expect(result.current.aiProviderId).toBe("provider-b"));

    await act(async () => {
      resolveFirst(responseFor("provider-a"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.aiProviders[0]?.id).toBe("provider-b");
    expect(result.current.aiModelId).toBe("provider-b-model");
    expect(result.current.aiProvidersLoading).toBe(false);
    expect(result.current.aiProvidersError).toBeNull();
  });

  it("ignores a refresh that finishes after the hook is disabled", async () => {
    let resolvePending!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => pendingResponse);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAiProviderSettings(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    await act(async () => {
      resolvePending(
        new Response(JSON.stringify({ providers, defaultProvider: { id: "custom-openai" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.aiProviders).toEqual([]);
    expect(result.current.aiProviderId).toBeNull();
    expect(result.current.aiModelId).toBeNull();
  });
});
