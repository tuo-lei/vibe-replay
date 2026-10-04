import { describe, expect, it, vi } from "vitest";
import { SqliteSnapshotRequiredError } from "@vibe-replay/provider-core/utils";
import { discoverProvidersSafely } from "../src/provider-discovery.js";
import type { Provider, SessionInfo } from "../src/types.js";

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

it("reports checkpoint-required coverage without exposing a source error's private details", async () => {
  const providers = [
    {
      name: "hermes",
      displayName: "Hermes",
      discover: async () => {
        throw new SqliteSnapshotRequiredError("PRIVATE SOURCE PATH AND PROMPT");
      },
      parse: vi.fn(),
    },
  ] as Provider[];
  const result = await discoverProvidersSafely(providers, undefined, { readOnly: true });
  expect(result.coverage).toEqual([
    {
      provider: "hermes",
      status: "failed",
      sessionCount: 0,
      errorCode: "checkpoint-required",
      message: expect.stringContaining("Checkpoint"),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE SOURCE");
});

it("retains healthy sessions while exposing partial checkpoint-required coverage", async () => {
  const healthy = {
    provider: "hermes",
    sessionId: "healthy-profile",
    filePath: "/healthy/state.db#session:healthy-profile",
    filePaths: ["/healthy/state.db#session:healthy-profile"],
  } as SessionInfo;
  const provider = {
    name: "hermes",
    displayName: "Hermes",
    discover: async () => {
      throw new SqliteSnapshotRequiredError("A profile requires checkpointing", [healthy]);
    },
    parse: vi.fn(),
  } as Provider;
  const onSession = vi.fn();
  const result = await discoverProvidersSafely([provider], onSession, { readOnly: true });
  expect(result.sessions).toEqual([healthy]);
  expect(result.failedProviders).toEqual(["hermes"]);
  expect(result.coverage).toMatchObject([
    { provider: "hermes", status: "failed", sessionCount: 1, errorCode: "checkpoint-required" },
  ]);
  expect(onSession).toHaveBeenCalledExactlyOnceWith(healthy);
});
