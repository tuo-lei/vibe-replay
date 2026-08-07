import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSessionInfo } from "../src/claude-code/discover.js";

const FIXTURE = join(__dirname, "fixtures", "discover-boilerplate.jsonl");

describe("extractSessionInfo – multi-prompt extraction", () => {
  it("skips boilerplate and collects real user prompts", async () => {
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe("boilerplate-session-1");
    expect(info?.slug).toBe("test-boilerplate");
    expect(info?.cwd).toBe("/Users/test/project");
    expect(info?.version).toBe("2.1.66");
    expect(info?.gitBranch).toBe("main");

    // Should have exactly 2 real prompts
    expect(info?.prompts).toHaveLength(2);
    expect(info?.prompts?.[0]).toContain("refactor the authentication module");
    expect(info?.prompts?.[1]).toContain("refresh token support");

    // firstPrompt should match prompts[0]
    expect(info?.firstPrompt).toBe(info?.prompts?.[0]);
  });

  it("skips tool_result messages (non-string content)", async () => {
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    // Line 9 has content as array (tool_result) — should not appear in prompts
    for (const p of info!.prompts) {
      expect(p).not.toContain("tool_result");
      expect(p).not.toContain("file contents here");
    }
  });

  it("skips boilerplate prompts shorter than 10 chars after cleaning", async () => {
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    // The /clear command and local-command-caveat should be filtered out
    for (const p of info!.prompts) {
      expect(p).not.toContain("/clear");
      expect(p).not.toContain("Caveat:");
    }
  });

  it("counts promptCount excluding tool_result lines", async () => {
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    // Lines with "type":"user": 3 (caveat), 5 (/clear), 7 (real), 9 (tool_result), 10 (real)
    // Line 9 has "tool_result" so it's excluded → promptCount = 4
    // (lightweight scan can't filter boilerplate — that's the prompts array's job)
    expect(info?.promptCount).toBe(4);
  });

  it("counts toolCallCount from tool_use blocks", async () => {
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    // No "type":"tool_use" in any assistant messages in this fixture
    expect(info?.toolCallCount).toBe(0);
  });

  it("extracts metadata from init line and uses last-record timestamp", async () => {
    // `timestamp` is the last activity (final record) — matches Claude Code's
    // own `/resume` semantics. Final record in the fixture is a turn_duration
    // at 10:00:12Z.
    const fileStat = await stat(FIXTURE);
    const info = await extractSessionInfo(FIXTURE, fileStat.size, "/Users/test/project");

    expect(info?.timestamp).toBe("2025-06-01T10:00:12Z");
    expect(info?.lineCount).toBe(11); // 12 lines minus empty trailing
  });

  it("keeps short non-system human prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-claude-short-prompt-"));
    const path = join(dir, "short.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "user",
        sessionId: "short-session",
        slug: "short",
        cwd: "/tmp/project",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Fix it" },
      })}\n`,
      "utf-8",
    );
    try {
      const fileStat = await stat(path);
      const info = await extractSessionInfo(path, fileStat.size, "/tmp/project");
      expect(info?.firstPrompt).toBe("Fix it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
