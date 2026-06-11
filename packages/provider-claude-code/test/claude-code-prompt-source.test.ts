/**
 * Regression coverage for the `promptSource` field on Claude Code user messages.
 *
 * Claude Code started stamping `promptSource: "sdk"` on user turns driven by the
 * Claude Agent SDK (routine / programmatic runs) rather than direct keyboard
 * input. These are still genuine prompts that drove the turn, so the parser must
 * keep rendering them as ordinary user turns — never drop or reclassify them.
 *
 * See issue #340 (schema-watch).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@vibe-replay/provider-contract";
import { parseClaudeCodeSession } from "../src/claude-code/parser.js";
import { transformToReplay } from "./helpers/transform.js";

type TextBlock = Extract<ContentBlock, { type: "text" }>;

const FIXTURE = join(import.meta.dirname, "fixtures/claude-code-prompt-source.jsonl");

describe("Claude Code: promptSource field", () => {
  it("renders SDK-originated user prompts as ordinary user turns", async () => {
    const result = await parseClaudeCodeSession(FIXTURE);
    const userTurns = result.turns.filter((t) => t.role === "user" && !t.subtype);
    const texts = userTurns.map((t) => (t.blocks[0] as TextBlock).text);
    expect(texts).toContain("Clean up the stale local branches that have been merged on remote.");
    expect(texts).toContain("Type the rest of this prompt yourself, please.");
    // Both the SDK-driven prompt and the plain prompt count equally.
    expect(userTurns).toHaveLength(2);
  });

  it("counts SDK-originated prompts in userPrompts stats", async () => {
    const parsed = await parseClaudeCodeSession(FIXTURE);
    const replay = transformToReplay(parsed, "claude-code", "~/test");
    expect(replay.meta.stats.userPrompts).toBe(2);
    const userScenes = replay.scenes.filter((s) => s.type === "user-prompt");
    expect(userScenes).toHaveLength(2);
  });
});
