import { describe, expect, it } from "vitest";
import { deduplicateSessionsByProvider, getAllProviders, getProvider } from "./index.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

function session(provider: string, sessionId = "shared-session"): SessionInfo {
  return {
    provider,
    sessionId,
    slug: `${provider}-${sessionId}`,
    project: "/test/project",
    cwd: "/test/project",
    version: "1.0.0",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: `/tmp/${provider}.jsonl`,
    filePaths: [`/tmp/${provider}.jsonl`],
    firstPrompt: `${provider} prompt`,
  };
}

describe("default provider registry", () => {
  it("keeps the built-in provider order stable", () => {
    expect(getAllProviders().map((provider) => provider.name)).toEqual([
      "claude-cowork",
      "claude-desktop",
      "claude-code",
      "codex",
      "cursor",
      "opencode",
      "pi",
    ]);
  });

  it("looks up providers by name", () => {
    expect(getProvider("cursor")?.displayName).toBe("Cursor");
    expect(getProvider("missing-provider")).toBeUndefined();
  });
});

describe("deduplicateSessionsByProvider", () => {
  it("prefers claude-desktop over claude-code for the same Claude CLI session", () => {
    const cli = session("claude-code");
    const desktop = session("claude-desktop");

    expect(deduplicateSessionsByProvider([cli, desktop])).toEqual([desktop]);
    expect(deduplicateSessionsByProvider([desktop, cli])).toEqual([desktop]);
  });

  it("prefers claude-cowork over other Claude providers when IDs collide defensively", () => {
    const cli = session("claude-code");
    const desktop = session("claude-desktop");
    const cowork = session("claude-cowork");

    expect(deduplicateSessionsByProvider([cli, desktop, cowork])).toEqual([cowork]);
  });

  it("keeps unrelated provider sessions with distinct IDs", () => {
    const cursor = session("cursor", "cursor-session");
    const codex = session("codex", "codex-session");
    const pi = session("pi", "pi-session");

    expect(deduplicateSessionsByProvider([cursor, codex, pi])).toEqual([cursor, codex, pi]);
  });

  it("keeps the first session when providers have no explicit priority", () => {
    const first = session("third-party", "same-id");
    const second = session("another-third-party", "same-id");

    expect(deduplicateSessionsByProvider([first, second])).toEqual([first]);
  });
});
