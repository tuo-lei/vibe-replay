import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "@vibe-replay/provider-claude-code/claude-code/parser";
import {
  BUNDLED_SAMPLE_SESSION_ID,
  isBundledSampleSession,
  loadBundledSampleSession,
  resolveBundledSamplePath,
  withBundledSampleIfEmpty,
} from "../src/bundled-sample.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

function session(sessionId: string): SessionInfo {
  return {
    provider: "cursor",
    sessionId,
    slug: sessionId.slice(0, 8),
    project: "/repo",
    cwd: "/repo",
    version: "",
    timestamp: "2026-08-20T10:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: `/${sessionId}.jsonl`,
    filePaths: [`/${sessionId}.jsonl`],
    firstPrompt: "prompt",
  };
}

describe("bundled sample session", () => {
  it("resolves the packaged welcome fixture", async () => {
    const path = await resolveBundledSamplePath();
    expect(path).toMatch(/assets\/samples\/welcome\.jsonl$/);
    const sample = await loadBundledSampleSession();
    expect(sample?.sessionId).toBe(BUNDLED_SAMPLE_SESSION_ID);
    expect(sample?.title).toBe("Sample: Welcome to vibe-replay");
    expect(sample?.provider).toBe("claude-code");
    expect(sample?.promptCount).toBe(1);
    expect(isBundledSampleSession(sample!)).toBe(true);
  });

  it("fills an empty discovery list and leaves real sessions alone", async () => {
    const empty = await withBundledSampleIfEmpty([]);
    expect(empty).toHaveLength(1);
    expect(empty[0].sessionId).toBe(BUNDLED_SAMPLE_SESSION_ID);

    const real = [session("real-session")];
    expect(await withBundledSampleIfEmpty(real)).toEqual(real);
  });

  it("parses through the Claude Code provider", async () => {
    const path = await resolveBundledSamplePath();
    expect(path).toBeTruthy();
    const parsed = await parseClaudeCodeSession(path!);
    expect(parsed.sessionId).toBe(BUNDLED_SAMPLE_SESSION_ID);
    expect(parsed.turns.some((turn) => turn.role === "user")).toBe(true);
    expect(parsed.turns.some((turn) => turn.role === "assistant")).toBe(true);
    const text = await readFile(path!, "utf-8");
    expect(text).toContain("bundled sample session");
  });
});
