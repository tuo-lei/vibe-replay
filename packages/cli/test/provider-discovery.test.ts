import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider, SessionInfo } from "@vibe-replay/provider-contract";
import { discoverProvidersSafely } from "../src/provider-discovery.js";

let testConfigRoot: string | undefined;

beforeEach(async () => {
  testConfigRoot = await mkdtemp(join(tmpdir(), "vibe-provider-discovery-"));
  vi.stubEnv("VIBE_REPLAY_CONFIG", join(testConfigRoot, "missing-config.json"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (testConfigRoot) await rm(testConfigRoot, { recursive: true, force: true });
  testConfigRoot = undefined;
});

function session(provider: string, sessionId: string): SessionInfo {
  return {
    provider,
    sessionId,
    slug: sessionId.slice(0, 8),
    project: "/repo",
    cwd: "/repo",
    version: "",
    timestamp: "2026-08-20T10:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: `/${provider}/${sessionId}.jsonl`,
    filePaths: [`/${provider}/${sessionId}.jsonl`],
    firstPrompt: "prompt",
  };
}

function provider(name: string, discover: Provider["discover"]): Provider {
  return {
    name,
    displayName: name,
    discover,
    parse: vi.fn(),
  };
}

describe("discoverProvidersSafely", () => {
  it("isolates provider failures and keeps healthy results", async () => {
    const onSession = vi.fn();
    const result = await discoverProvidersSafely(
      [
        provider("claude-code", async () => [session("claude-code", "healthy")]),
        provider("cursor", async () => {
          throw new Error("upstream schema changed");
        }),
        provider("pi", async () => [session("pi", "pi-session")]),
      ],
      onSession,
    );

    expect(result.sessions.map((item) => item.sessionId)).toEqual(["healthy", "pi-session"]);
    expect(result.failedProviders).toEqual(["cursor"]);
    expect(onSession).toHaveBeenCalledTimes(2);
  });

  it("applies the shared provider priority deduplication", async () => {
    const result = await discoverProvidersSafely([
      provider("claude-code", async () => [session("claude-code", "shared")]),
      provider("claude-desktop", async () => [session("claude-desktop", "shared")]),
    ]);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].provider).toBe("claude-desktop");
    expect(result.failedProviders).toEqual([]);
  });

  it("propagates session callback failures without blaming the provider", async () => {
    const callbackError = new Error("SSE stream closed");

    await expect(
      discoverProvidersSafely(
        [provider("cursor", async () => [session("cursor", "cursor-session")])],
        () => {
          throw callbackError;
        },
      ),
    ).rejects.toThrow("SSE stream closed");
  });
});

describe("early provider feedback", () => {
  it("reports all detected roots before the first slow discovery completes", async () => {
    const states: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = {
      ...provider("codex", async () => {
        await slow;
        return [session("codex", "one")];
      }),
      detect: async () => true,
    };
    const second = { ...provider("pi", async () => []), detect: async () => true };
    const absent = { ...provider("cursor", async () => []), detect: async () => false };
    const run = discoverProvidersSafely([first, second, absent], undefined, {
      onProvider: (state) => {
        states.push(`${state.provider}:${state.status}:${state.detected}`);
      },
    });
    await vi.waitFor(() => expect(states).toContain("codex:reading:true"));
    expect(states).toContain("codex:found:true");
    expect(states).toContain("pi:found:true");
    expect(states).not.toContain("cursor:found:true");
    expect(states).not.toContain("codex:ready:true");
    release();
    const result = await run;
    expect(result.sessions).toHaveLength(1);
    expect(states).toContain("codex:ready:true");
    expect(states).toContain("pi:empty:true");
    expect(states).toContain("cursor:empty:false");
  });

  it("uses actual sessions if a probe fails and ignores progress observer errors", async () => {
    const source = {
      ...provider("pi", async () => [session("pi", "one")]),
      detect: async () => {
        throw new Error("probe unavailable");
      },
    };
    const observer = vi.fn((state) => {
      if (state.status === "reading") throw new Error("closed browser");
    });
    const result = await discoverProvidersSafely([source], undefined, {
      onProvider: observer,
      readOnly: true,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.failedProviders).toEqual([]);
    expect(observer).toHaveBeenLastCalledWith({
      provider: "pi",
      detected: true,
      status: "ready",
      sessionCount: 1,
    });
  });
});
