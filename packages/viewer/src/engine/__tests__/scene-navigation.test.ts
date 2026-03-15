import { describe, expect, it } from "vitest";
import {
  computeNextIndex,
  computePrevIndex,
  computeUserPromptIndices,
  findNextUserPrompt,
  findPrevUserPrompt,
} from "../scene-navigation";
import { compactionSummary, textResponse, thinking, toolCall, userPrompt } from "./helpers";

// -- computeUserPromptIndices --

describe("computeUserPromptIndices", () => {
  it("returns empty array for no scenes", () => {
    expect(computeUserPromptIndices([])).toEqual([]);
  });

  it("returns empty array when no user prompts exist", () => {
    expect(computeUserPromptIndices([thinking(), textResponse()])).toEqual([]);
  });

  it("finds all user-prompt indices", () => {
    const scenes = [userPrompt(), thinking(), textResponse(), userPrompt(), toolCall()];
    expect(computeUserPromptIndices(scenes)).toEqual([0, 3]);
  });

  it("works when all scenes are user prompts", () => {
    const scenes = [userPrompt("a"), userPrompt("b"), userPrompt("c")];
    expect(computeUserPromptIndices(scenes)).toEqual([0, 1, 2]);
  });
});

// -- findNextUserPrompt --

describe("findNextUserPrompt", () => {
  const indices = [0, 5, 10, 20];

  it("finds next prompt after current position", () => {
    expect(findNextUserPrompt(indices, 0)).toBe(5);
    expect(findNextUserPrompt(indices, 3)).toBe(5);
    expect(findNextUserPrompt(indices, 5)).toBe(10);
  });

  it("returns undefined when no next prompt exists", () => {
    expect(findNextUserPrompt(indices, 20)).toBeUndefined();
    expect(findNextUserPrompt(indices, 25)).toBeUndefined();
  });

  it("returns undefined for empty indices", () => {
    expect(findNextUserPrompt([], 0)).toBeUndefined();
  });

  it("finds first prompt when current is -1", () => {
    expect(findNextUserPrompt(indices, -1)).toBe(0);
  });
});

// -- findPrevUserPrompt --

describe("findPrevUserPrompt", () => {
  const indices = [0, 5, 10, 20];

  it("finds previous prompt before current position", () => {
    expect(findPrevUserPrompt(indices, 20)).toBe(10);
    expect(findPrevUserPrompt(indices, 7)).toBe(5);
    expect(findPrevUserPrompt(indices, 5)).toBe(0);
  });

  it("returns undefined when no previous prompt exists", () => {
    expect(findPrevUserPrompt(indices, 0)).toBeUndefined();
    expect(findPrevUserPrompt(indices, -1)).toBeUndefined();
  });

  it("returns undefined for empty indices", () => {
    expect(findPrevUserPrompt([], 5)).toBeUndefined();
  });
});

// -- computeNextIndex --

describe("computeNextIndex", () => {
  it("returns -1 when past end of scenes", () => {
    const scenes = [userPrompt(), textResponse()];
    expect(computeNextIndex(scenes, 1, { promptsOnly: false, compactAssistant: false })).toBe(-1);
  });

  it("advances to next scene normally", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: false })).toBe(1);
  });

  it("batches consecutive same-name tool calls", () => {
    const scenes = [
      userPrompt(),
      toolCall("Read"),
      toolCall("Read"),
      toolCall("Read"),
      textResponse(),
    ];
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: false })).toBe(3);
  });

  it("in prompts-only mode, skips to next user-prompt", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      textResponse(),
      toolCall(),
      userPrompt("second"),
    ];
    expect(computeNextIndex(scenes, 0, { promptsOnly: true, compactAssistant: false })).toBe(4);
  });

  it("in prompts-only mode, returns -1 when no more prompts", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    expect(computeNextIndex(scenes, 0, { promptsOnly: true, compactAssistant: false })).toBe(-1);
  });

  it("in prompts-only mode from before first scene", () => {
    const scenes = [thinking(), userPrompt()];
    expect(computeNextIndex(scenes, -1, { promptsOnly: true, compactAssistant: false })).toBe(1);
  });

  // -- compact-assistant mode (lines 60-75) --

  it("in compact mode, skips assistant block to land on last scene of the group", () => {
    const scenes = [userPrompt(), thinking(), toolCall(), textResponse(), userPrompt("second")];
    // From the user-prompt at index 0, next is index 1 (thinking), which is not a boundary.
    // Should skip to the last assistant scene before the next user-prompt: index 3.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(3);
  });

  it("in compact mode, does not skip when next scene is a user-prompt", () => {
    const scenes = [userPrompt("first"), userPrompt("second"), thinking()];
    // Next scene after index 0 is another user-prompt (boundary), so it just advances normally.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(1);
  });

  it("in compact mode, does not skip when next scene is a compaction-summary", () => {
    const scenes = [userPrompt(), compactionSummary(), thinking()];
    // Next scene is compaction-summary (boundary), so it just advances normally.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(1);
  });

  it("in compact mode, skips assistant block that ends at the last scene", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    // No following user-prompt — the assistant block runs to the end of scenes.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(2);
  });

  it("in compact mode, handles single assistant scene between prompts", () => {
    const scenes = [userPrompt(), textResponse(), userPrompt("second")];
    // Only one assistant scene (index 1). It's not a boundary, so skip to end of group = index 1.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(1);
  });

  it("in compact mode, skips past multiple assistant scenes including tool calls", () => {
    const scenes = [
      userPrompt(),
      thinking(),
      toolCall("Read"),
      toolCall("Write"),
      textResponse(),
      userPrompt("second"),
    ];
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(4);
  });

  it("in compact mode, stops at compaction-summary boundary", () => {
    const scenes = [
      userPrompt(),
      thinking(),
      textResponse(),
      compactionSummary(),
      thinking(),
      textResponse(),
    ];
    // From index 0, next is index 1 (thinking, not boundary). Skip forward until we hit
    // compaction-summary at index 3. The last non-boundary before it is index 2.
    expect(computeNextIndex(scenes, 0, { promptsOnly: false, compactAssistant: true })).toBe(2);
  });

  // -- prompts-only mode with compaction-summary --

  it("in prompts-only mode, stops at compaction-summary", () => {
    const scenes = [userPrompt(), thinking(), compactionSummary(), textResponse()];
    expect(computeNextIndex(scenes, 0, { promptsOnly: true, compactAssistant: false })).toBe(2);
  });
});

// -- computePrevIndex --

describe("computePrevIndex", () => {
  const defaultPrefs = { promptsOnly: false, compactAssistant: false };

  // -- basic / default ALL mode --

  it("returns 0 when already at the beginning", () => {
    const scenes = [userPrompt(), thinking()];
    expect(computePrevIndex(scenes, 0, defaultPrefs)).toBe(0);
  });

  it("moves back one scene normally", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    expect(computePrevIndex(scenes, 2, defaultPrefs)).toBe(1);
  });

  it("moves back from index 1 to index 0", () => {
    const scenes = [userPrompt(), textResponse()];
    expect(computePrevIndex(scenes, 1, defaultPrefs)).toBe(0);
  });

  // -- batch grouping in default mode (lines 130-141) --

  it("skips back over a batch of same-name batchable tool calls", () => {
    const scenes = [
      userPrompt(),
      toolCall("Read"),
      toolCall("Read"),
      toolCall("Read"),
      textResponse(),
    ];
    // Moving back from textResponse (index 4), prevIdx = 3, which is a batchable Read.
    // Should skip back to the start of the batch: index 1.
    expect(computePrevIndex(scenes, 4, defaultPrefs)).toBe(1);
  });

  it("does not batch tool calls with different names", () => {
    const scenes = [userPrompt(), toolCall("Read"), toolCall("Write"), textResponse()];
    // Moving back from textResponse (index 3), prevIdx = 2 (Write tool call).
    // The scene before it (index 1) is Read, different name. Batch of 1 = stays at index 2.
    expect(computePrevIndex(scenes, 3, defaultPrefs)).toBe(2);
  });

  it("does not batch tool calls that have diff", () => {
    const scenes = [
      userPrompt(),
      toolCall("Write", { diff: true }),
      toolCall("Write", { diff: true }),
      textResponse(),
    ];
    // prevIdx = 2, which has diff so not batchable. Returns 2 as-is.
    expect(computePrevIndex(scenes, 3, defaultPrefs)).toBe(2);
  });

  it("does not batch tool calls that have bashOutput", () => {
    const scenes = [
      userPrompt(),
      toolCall("Bash", { bashOutput: true }),
      toolCall("Bash", { bashOutput: true }),
      textResponse(),
    ];
    expect(computePrevIndex(scenes, 3, defaultPrefs)).toBe(2);
  });

  it("does not batch when previous scene is not a tool call", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    // prevIdx = 1 (thinking), not a tool-call. Returns 1.
    expect(computePrevIndex(scenes, 2, defaultPrefs)).toBe(1);
  });

  it("batches stop at index 0", () => {
    const scenes = [toolCall("Read"), toolCall("Read"), toolCall("Read"), textResponse()];
    // Moving back from textResponse (index 3), prevIdx = 2.
    // Batch of Read calls goes back to index 0.
    expect(computePrevIndex(scenes, 3, defaultPrefs)).toBe(0);
  });

  // -- prompts-only mode (lines 94-103) --

  it("in prompts-only mode, skips back to previous user-prompt", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      textResponse(),
      toolCall(),
      userPrompt("second"),
    ];
    expect(computePrevIndex(scenes, 4, { promptsOnly: true, compactAssistant: false })).toBe(0);
  });

  it("in prompts-only mode, stays at 0 when no previous prompt", () => {
    const scenes = [thinking(), textResponse(), userPrompt()];
    // From index 2 (user-prompt), prevIdx = 1 (textResponse). Skip back looking for user-prompt.
    // None found, hits index 0. scenes[0] is thinking (not user-prompt), but loop stops at 0.
    expect(computePrevIndex(scenes, 2, { promptsOnly: true, compactAssistant: false })).toBe(0);
  });

  it("in prompts-only mode, stops at compaction-summary", () => {
    const scenes = [
      userPrompt(),
      thinking(),
      compactionSummary(),
      textResponse(),
      userPrompt("second"),
    ];
    // From index 4, prevIdx = 3. Skip back: index 3 is textResponse, index 2 is compaction-summary. Stop.
    expect(computePrevIndex(scenes, 4, { promptsOnly: true, compactAssistant: false })).toBe(2);
  });

  it("in prompts-only mode, skips multiple non-prompt scenes", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      toolCall("Read"),
      toolCall("Write"),
      textResponse(),
      userPrompt("second"),
      thinking(),
      textResponse(),
      userPrompt("third"),
    ];
    expect(computePrevIndex(scenes, 8, { promptsOnly: true, compactAssistant: false })).toBe(5);
    expect(computePrevIndex(scenes, 5, { promptsOnly: true, compactAssistant: false })).toBe(0);
  });

  // -- compact-assistant mode (lines 105-126) --

  it("in compact mode, skips backwards over assistant block to previous prompt", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      toolCall(),
      textResponse(),
      userPrompt("second"),
    ];
    // Currently at index 3 (textResponse, inside assistant block).
    // Not a boundary, so skip back to start of assistant block (index 1), then return start - 1 = 0.
    expect(computePrevIndex(scenes, 3, { promptsOnly: false, compactAssistant: true })).toBe(0);
  });

  it("in compact mode, from user-prompt moves back one step", () => {
    const scenes = [userPrompt("first"), thinking(), textResponse(), userPrompt("second")];
    // At index 3 (user-prompt, a boundary). Compact mode just moves back one step: index 2.
    expect(computePrevIndex(scenes, 3, { promptsOnly: false, compactAssistant: true })).toBe(2);
  });

  it("in compact mode, from compaction-summary moves back one step", () => {
    const scenes = [userPrompt(), thinking(), textResponse(), compactionSummary()];
    // At index 3 (compaction-summary, a boundary). Moves back one step: index 2.
    expect(computePrevIndex(scenes, 3, { promptsOnly: false, compactAssistant: true })).toBe(2);
  });

  it("in compact mode, skips back over entire assistant block to reach index 0", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    // At index 2 (textResponse, inside assistant block). Start = 2, then scan back:
    // scenes[1] is thinking (not boundary), so start = 1. scenes[0] is user-prompt (boundary), stop.
    // Return start - 1 = 0. But Math.max(0, 0) = 0.
    expect(computePrevIndex(scenes, 2, { promptsOnly: false, compactAssistant: true })).toBe(0);
  });

  it("in compact mode, skips back from inside assistant block with no preceding prompt", () => {
    const scenes = [thinking(), toolCall(), textResponse()];
    // At index 2 (textResponse), not a boundary. Scan back: scenes[1] is tool-call, scenes[0] is thinking.
    // start goes to 0 (since no boundary found). Return Math.max(0, 0 - 1) = 0.
    expect(computePrevIndex(scenes, 2, { promptsOnly: false, compactAssistant: true })).toBe(0);
  });

  it("in compact mode, skips back over long assistant block", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      toolCall("Read"),
      toolCall("Write"),
      textResponse(),
      toolCall("Bash", { bashOutput: true }),
      userPrompt("second"),
    ];
    // At index 5 (tool-call with bashOutput, inside assistant block). Scan back to find boundary.
    // scenes[0] is user-prompt. So start = 1, return 0.
    expect(computePrevIndex(scenes, 5, { promptsOnly: false, compactAssistant: true })).toBe(0);
  });

  it("in compact mode, stops at compaction-summary boundary when scanning back", () => {
    const scenes = [
      userPrompt(),
      compactionSummary(),
      thinking(),
      textResponse(),
      userPrompt("second"),
    ];
    // At index 3 (textResponse, inside assistant block). Scan back:
    // scenes[2] is thinking (not boundary), start = 2.
    // scenes[1] is compaction-summary (boundary), stop. start stays at 2.
    // Return Math.max(0, 2 - 1) = 1.
    expect(computePrevIndex(scenes, 3, { promptsOnly: false, compactAssistant: true })).toBe(1);
  });

  // -- edge cases --

  it("handles single scene at index 0", () => {
    const scenes = [userPrompt()];
    expect(computePrevIndex(scenes, 0, defaultPrefs)).toBe(0);
  });
});
