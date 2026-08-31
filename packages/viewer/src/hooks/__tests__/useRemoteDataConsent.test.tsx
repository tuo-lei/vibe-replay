// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_DATA_CONSENT_STORAGE_KEY, useRemoteDataConsent } from "../useRemoteDataConsent";

function settingsResponse(remoteSources: unknown[]) {
  return {
    ok: true,
    json: async () => ({ remoteSources }),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/settings")) return settingsResponse([{ id: "remote-dev" }]);
      throw new Error(`Unexpected request: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("useRemoteDataConsent", () => {
  it("loads remote-source availability and persists the consent choice", async () => {
    const { result } = renderHook(() => useRemoteDataConsent(true));

    await waitFor(() => expect(result.current.remoteSourcesLoading).toBe(false));
    expect(result.current.hasConfiguredRemoteSource).toBe(true);
    expect(result.current.allowRemoteData).toBe(false);

    act(() => result.current.setAllowRemoteData(true));

    expect(result.current.allowRemoteData).toBe(true);
    expect(localStorage.getItem(REMOTE_DATA_CONSENT_STORAGE_KEY)).toBe("1");
  });

  it("synchronizes consent changes across mounted surfaces", async () => {
    const first = renderHook(() => useRemoteDataConsent(true));
    const second = renderHook(() => useRemoteDataConsent(true));

    await waitFor(() => {
      expect(first.result.current.hasConfiguredRemoteSource).toBe(true);
      expect(second.result.current.hasConfiguredRemoteSource).toBe(true);
    });

    act(() => first.result.current.setAllowRemoteData(true));
    await waitFor(() => expect(second.result.current.allowRemoteData).toBe(true));

    first.unmount();
    second.unmount();
  });

  it("fails closed when no remote source is configured", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      async () => settingsResponse([]) as unknown as Response,
    );
    const { result } = renderHook(() => useRemoteDataConsent(true));

    await waitFor(() => expect(result.current.remoteSourcesLoading).toBe(false));
    expect(result.current.hasConfiguredRemoteSource).toBe(false);
  });
});
