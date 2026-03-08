import { describe, expect, it } from "vitest";
import type { Scene } from "../../types";
import {
  computeNextIndex,
  computeUserPromptIndices,
  findNextUserPrompt,
  findPrevUserPrompt,
} from "../scene-navigation";

// -- Helpers --

function userPrompt(content = "hello"): Scene {
  return { type: "user-prompt", content };
}

function thinking(content = "hmm"): Scene {
  return { type: "thinking", content };
}

function textResponse(content = "hi"): Scene {
  return { type: "text-response", content };
}

function toolCall(toolName = "Read"): Scene {
  return { type: "tool-call", toolName, input: {}, result: "" };
}

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
    expect(computeNextIndex(scenes, 1, false)).toBe(-1);
  });

  it("advances to next scene normally", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    expect(computeNextIndex(scenes, 0, false)).toBe(1);
  });

  it("batches consecutive same-name tool calls", () => {
    const scenes = [
      userPrompt(),
      toolCall("Read"),
      toolCall("Read"),
      toolCall("Read"),
      textResponse(),
    ];
    expect(computeNextIndex(scenes, 0, false)).toBe(3);
  });

  it("in prompts-only mode, skips to next user-prompt", () => {
    const scenes = [
      userPrompt("first"),
      thinking(),
      textResponse(),
      toolCall(),
      userPrompt("second"),
    ];
    expect(computeNextIndex(scenes, 0, true)).toBe(4);
  });

  it("in prompts-only mode, returns -1 when no more prompts", () => {
    const scenes = [userPrompt(), thinking(), textResponse()];
    expect(computeNextIndex(scenes, 0, true)).toBe(-1);
  });

  it("in prompts-only mode from before first scene", () => {
    const scenes = [thinking(), userPrompt()];
    expect(computeNextIndex(scenes, -1, true)).toBe(1);
  });
});
