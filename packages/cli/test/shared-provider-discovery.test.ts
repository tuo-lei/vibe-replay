import { describe, expect, it, vi } from "vitest";
import type { SourceProviderProgress } from "@vibe-replay/types";
import { createSharedProviderDiscovery } from "../src/shared-provider-discovery.js";

it("replays detected sources to a dashboard joining an existing scanner run, in order", async () => {
  let emit!: (state: SourceProviderProgress) => Promise<void> | void;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discover = vi.fn(async (_session, onProvider) => {
    emit = onProvider;
    await emit({ provider: "codex", detected: true, status: "found" });
    await emit({ provider: "codex", detected: true, status: "reading" });
    await hold;
    await emit({ provider: "codex", detected: true, status: "ready", sessionCount: 30 });
    return { sessions: [], failedProviders: [], coverage: [] };
  });
  const shared = createSharedProviderDiscovery(discover);
  const scanner = shared();
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  const events: SourceProviderProgress[] = [];
  const dashboard = shared(undefined, async (state) => {
    await Promise.resolve();
    events.push(state);
  });
  release();
  await Promise.all([scanner, dashboard]);
  expect(discover).toHaveBeenCalledOnce();
  expect(events.map((state) => state.status)).toEqual(["reading", "ready"]);
  expect(events[1].sessionCount).toBe(30);
});

describe("shared discovery lifetime", () => {
  it("isolates disconnected observers and starts a fresh run after completion", async () => {
    const discover = vi.fn(async (onSession, onProvider) => {
      await onProvider({ provider: "pi", detected: true, status: "found" });
      await onSession({ provider: "pi" });
      return { sessions: [], failedProviders: [], coverage: [] };
    });
    const shared = createSharedProviderDiscovery(discover);
    const healthy = vi.fn();
    const disconnected = () => {
      throw new Error("closed");
    };
    await Promise.all([shared(disconnected, disconnected), shared(healthy, healthy)]);
    expect(healthy).toHaveBeenCalledTimes(2);
    await shared();
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
