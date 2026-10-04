import { afterEach, describe, expect, it, vi } from "vitest";
import { getProvider } from "../src/providers/index.js";
import { discoverCliSessions } from "../src/session-workflows.js";

const { remoteDiscovery, cacheWrite } = vi.hoisted(() => ({
  remoteDiscovery: vi.fn(async () => ({ sessions: [], failedTargets: [] })),
  cacheWrite: vi.fn(),
}));
vi.mock("../src/remote.js", async () => ({
  ...(await vi.importActual("../src/remote.js")),
  discoverConfiguredRemoteSessions: remoteDiscovery,
}));
vi.mock("../src/cache.js", () => ({ readFileCache: async () => null, writeFileCache: cacheWrite }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("CLI preflight discovery", () => {
  it("propagates read-only mode to local providers without changing ordinary discovery", async () => {
    const discover = vi.spyOn(getProvider("pi")!, "discover").mockResolvedValue([]);
    await discoverCliSessions({ provider: "pi", readOnly: true, refresh: true });
    expect(discover).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
    discover.mockClear();
    await discoverCliSessions({ provider: "pi", refresh: true });
    expect(discover).toHaveBeenCalledExactlyOnceWith();
  });

  it("propagates read-only mode to remote discovery and suppresses the CLI cache write", async () => {
    vi.spyOn(getProvider("pi")!, "discover").mockResolvedValue([]);
    const result = await discoverCliSessions({ provider: "pi", readOnly: true, refresh: true });
    expect(result.sessions).toEqual([]);
    expect(remoteDiscovery).toHaveBeenCalledExactlyOnceWith(["pi"], { readOnly: true });
    expect(cacheWrite).not.toHaveBeenCalled();
  });
});
