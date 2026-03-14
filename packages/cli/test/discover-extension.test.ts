import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSessionInfo } from "../src/providers/claude-code/discover.js";

const FIXTURE_EXT = join(__dirname, "fixtures", "discover-extension.jsonl");
const FIXTURE_STR = join(__dirname, "fixtures", "discover-boilerplate.jsonl");
const FIXTURE_EMPTY_ARR = join(__dirname, "fixtures", "discover-empty-array.jsonl");

describe("extractSessionInfo – VS Code extension array content format", () => {
  it("discovers sessions where user message content is an array of blocks", async () => {
    const fileStat = await stat(FIXTURE_EXT);
    const info = await extractSessionInfo(FIXTURE_EXT, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe("ext-session-1");
    expect(info?.slug).toBe("test-extension");
    expect(info?.cwd).toBe("/Users/test/project");
    expect(info?.version).toBe("2.1.76");
    expect(info?.gitBranch).toBe("feat/auth");
  });

  it("extracts text prompts from array content blocks", async () => {
    const fileStat = await stat(FIXTURE_EXT);
    const info = await extractSessionInfo(FIXTURE_EXT, fileStat.size, "/Users/test/project");

    expect(info?.prompts).toHaveLength(2);
    expect(info?.prompts?.[0]).toContain("refactor the authentication module");
    expect(info?.prompts?.[1]).toContain("refresh token support");
    expect(info?.firstPrompt).toBe(info?.prompts?.[0]);
  });

  it("extracts only text from mixed content arrays (text + image blocks)", async () => {
    // The 2nd user message has both a text block and an image block.
    // Only the text should be extracted; image data must not leak into prompts.
    const fileStat = await stat(FIXTURE_EXT);
    const info = await extractSessionInfo(FIXTURE_EXT, fileStat.size, "/Users/test/project");

    expect(info?.prompts?.[1]).toContain("refresh token support");
    for (const p of info!.prompts) {
      expect(p).not.toContain("iVBOR");
      expect(p).not.toContain("base64");
    }
  });

  it("extracts timestamp from file-history-snapshot", async () => {
    const fileStat = await stat(FIXTURE_EXT);
    const info = await extractSessionInfo(FIXTURE_EXT, fileStat.size, "/Users/test/project");

    expect(info?.timestamp).toBe("2025-07-01T10:00:01Z");
  });
});

describe("extractSessionInfo – edge cases", () => {
  it("returns null for sessions with empty content arrays", async () => {
    const fileStat = await stat(FIXTURE_EMPTY_ARR);
    const info = await extractSessionInfo(FIXTURE_EMPTY_ARR, fileStat.size, "/Users/test/project");

    expect(info).toBeNull();
  });
});

describe("extractSessionInfo – backward compatibility with string content", () => {
  it("still discovers sessions with traditional string content format", async () => {
    const fileStat = await stat(FIXTURE_STR);
    const info = await extractSessionInfo(FIXTURE_STR, fileStat.size, "/Users/test/project");

    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe("boilerplate-session-1");
    expect(info?.prompts).toHaveLength(2);
    expect(info?.prompts?.[0]).toContain("refactor the authentication module");
    expect(info?.prompts?.[1]).toContain("refresh token support");
  });
});
