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

describe("parallel provider discovery", () => {
  it.each([30, 500])(
    "streams %i fast sessions while another source is blocked, preserving final priority",
    async (count) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const streamed: string[] = [];
      const states: string[] = [];
      let activeObservers = 0;
      let peakObservers = 0;
      const slow = provider("claude-desktop", async () => {
        await blocked;
        return [session("claude-desktop", "shared")];
      });
      const fast = provider("claude-code", async () => [
        session("claude-code", "shared"),
        ...Array.from({ length: count - 1 }, (_, index) => session("claude-code", `fast-${index}`)),
      ]);
      const run = discoverProvidersSafely(
        [slow, fast],
        async (entry) => {
          activeObservers++;
          peakObservers = Math.max(peakObservers, activeObservers);
          await Promise.resolve();
          streamed.push(entry.sessionId);
          activeObservers--;
        },
        {
          onProvider: (state) => {
            states.push(`${state.provider}:${state.status}`);
          },
        },
      );
      try {
        await vi.waitFor(() => expect(streamed).toHaveLength(count));
        expect(states).toContain("claude-desktop:reading");
        expect(states).toContain("claude-code:ready");
        expect(states).not.toContain("claude-desktop:ready");
      } finally {
        release();
      }
      const result = await run;
      expect(result.sessions).toHaveLength(count);
      expect(result.sessions[0]).toMatchObject({ provider: "claude-desktop", sessionId: "shared" });
      expect(result.coverage.map((entry) => entry.provider)).toEqual([
        "claude-desktop",
        "claude-code",
      ]);
      expect(peakObservers).toBe(1);
      expect(streamed).toHaveLength(count + 1);
    },
  );

  it("runs all sources concurrently, preserving failure coverage and read-only options", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const sources = ["cursor", "pi", "codex"].map((name) =>
      provider(
        name,
        vi.fn(async () => {
          started.push(name);
          await blocked;
          if (name !== "pi") throw new Error("no such table: session");
          return [session(name, "healthy")];
        }),
      ),
    );
    const run = discoverProvidersSafely(sources, undefined, { readOnly: true });
    try {
      await vi.waitFor(() => expect(started).toEqual(["cursor", "pi", "codex"]));
    } finally {
      release();
    }
    const result = await run;
    expect(result.failedProviders).toEqual(["cursor", "codex"]);
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(["healthy"]);
    expect(result.coverage.map((entry) => entry.status)).toEqual(["failed", "ready", "failed"]);
    for (const source of sources)
      expect(source.discover).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });
});
