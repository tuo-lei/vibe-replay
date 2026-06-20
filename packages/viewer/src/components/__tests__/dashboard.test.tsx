// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserAPIs } from "../../test-utils/jsdom-stubs";
import Dashboard from "../Dashboard";

beforeEach(() => {
  stubBrowserAPIs();
  // Dashboard fetches replay/source data on mount. Reject so it exercises its
  // error/empty handling instead of hitting the network — modelling each
  // endpoint's exact response shape is out of scope for a smoke test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard (smoke)", () => {
  it("renders its chrome (search + facets) without crashing", () => {
    render(<Dashboard />);
    // Static chrome rendered before data loads (mobile + desktop search boxes).
    expect(screen.getAllByPlaceholderText(/search/i).length).toBeGreaterThan(0);
    // Sidebar facet headers.
    expect(screen.getByText(/Provider/)).toBeTruthy();
    expect(screen.getByText(/Project path/)).toBeTruthy();
  });

  it("kicks off a data fetch on mount", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // (The post-fetch view depends on each endpoint's exact response shape, so
    // asserting it is out of scope for this smoke test — the mount + load path
    // not throwing is the signal.)
  });
});
