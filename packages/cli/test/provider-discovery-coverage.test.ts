import { describe, expect, it, vi } from "vitest";
import { discoverProvidersSafely } from "../src/provider-discovery.js";
import type { Provider } from "../src/types.js";

vi.mock("../src/remote.js", () => ({
  discoverConfiguredRemoteSessions: async () => ({ sessions: [], failedTargets: [] }),
}));

describe("provider failure coverage", () => {
  it("distinguishes schema failure from an empty provider and never returns raw error content", async () => {
    const providers = [
      {
        name: "opencode",
        displayName: "OpenCode",
        discover: async () => {
          throw new Error("no such table: session; private prompt and secret-token");
        },
        parse: vi.fn(),
      },
      { name: "pi", displayName: "Pi", discover: async () => [], parse: vi.fn() },
    ] as Provider[];
    const result = await discoverProvidersSafely(providers);
    expect(result.coverage).toEqual([
      {
        provider: "opencode",
        status: "failed",
        sessionCount: 0,
        errorCode: "schema-incompatible",
        message: expect.stringContaining("storage format"),
      },
      { provider: "pi", status: "empty", sessionCount: 0 },
    ]);
    expect(result.failedProviders).toEqual(["opencode"]);
    expect(JSON.stringify(result.coverage)).not.toContain("secret-token");
  });
});
