import { describe, expect, it } from "vitest";
import type { Scene } from "../../types";
import { findBatchEnd, isBatchable, sceneDuration } from "../scene-timing";
import { textResponse, thinking, toolCall, userPrompt } from "./helpers";

// -- isBatchable --

describe("isBatchable", () => {
  it("returns true for simple tool-call (no diff, no bashOutput)", () => {
    expect(isBatchable(toolCall("Read"))).toBe(true);
  });

  it("returns false for tool-call with diff", () => {
    expect(isBatchable(toolCall("Edit", { diff: true }))).toBe(false);
  });

  it("returns false for tool-call with bashOutput", () => {
    expect(isBatchable(toolCall("Bash", { bashOutput: true }))).toBe(false);
  });

  it("returns false for non-tool-call scenes", () => {
    expect(isBatchable(userPrompt())).toBe(false);
    expect(isBatchable(thinking())).toBe(false);
    expect(isBatchable(textResponse())).toBe(false);
  });
});

// -- findBatchEnd --

describe("findBatchEnd", () => {
  it("returns same index for non-batchable scene", () => {
    const scenes = [userPrompt(), toolCall("Read")];
    expect(findBatchEnd(scenes, 0)).toBe(0);
  });

  it("returns same index for single batchable scene", () => {
    const scenes = [toolCall("Read"), userPrompt()];
    expect(findBatchEnd(scenes, 0)).toBe(0);
  });

  it("merges consecutive same-name batchable tool calls", () => {
    const scenes = [toolCall("Read"), toolCall("Read"), toolCall("Read"), userPrompt()];
    expect(findBatchEnd(scenes, 0)).toBe(2);
  });

  it("stops at different tool name", () => {
    const scenes = [toolCall("Read"), toolCall("Read"), toolCall("Glob"), toolCall("Read")];
    expect(findBatchEnd(scenes, 0)).toBe(1);
  });

  it("stops at tool-call with diff", () => {
    const scenes = [toolCall("Edit"), toolCall("Edit", { diff: true }), toolCall("Edit")];
    expect(findBatchEnd(scenes, 0)).toBe(0);
  });

  it("stops at tool-call with bashOutput", () => {
    const scenes = [toolCall("Bash"), toolCall("Bash", { bashOutput: true })];
    expect(findBatchEnd(scenes, 0)).toBe(0);
  });

  it("works starting from middle of array", () => {
    const scenes = [userPrompt(), toolCall("Read"), toolCall("Read"), toolCall("Read")];
    expect(findBatchEnd(scenes, 1)).toBe(3);
  });

  it("returns idx for last element in array", () => {
    const scenes = [toolCall("Read")];
    expect(findBatchEnd(scenes, 0)).toBe(0);
  });
});

// -- sceneDuration --

describe("sceneDuration", () => {
  it("user-prompt is 1200ms at 1x", () => {
    expect(sceneDuration(userPrompt(), 1)).toBe(1200);
  });

  it("user-prompt at 2x is half duration", () => {
    expect(sceneDuration(userPrompt(), 2)).toBe(600);
  });

  it("thinking is 600ms at 1x", () => {
    expect(sceneDuration(thinking(), 1)).toBe(600);
  });

  it("text-response minimum is 800ms", () => {
    expect(sceneDuration(textResponse("hi"), 1)).toBe(800);
  });

  it("text-response scales with content length", () => {
    const short = sceneDuration(textResponse("hi"), 1);
    const long = sceneDuration(textResponse("x".repeat(1000)), 1);
    expect(long).toBeGreaterThan(short);
  });

  it("text-response caps at 3000ms", () => {
    const veryLong = sceneDuration(textResponse("x".repeat(10000)), 1);
    expect(veryLong).toBe(3000);
  });

  it("tool-call with diff is 1200ms", () => {
    expect(sceneDuration(toolCall("Edit", { diff: true }), 1)).toBe(1200);
  });

  it("tool-call with bashOutput is 900ms", () => {
    expect(sceneDuration(toolCall("Bash", { bashOutput: true }), 1)).toBe(900);
  });

  it("simple tool-call is 400ms", () => {
    expect(sceneDuration(toolCall("Read"), 1)).toBe(400);
  });

  it("respects speed multiplier for all types", () => {
    const scenes: Scene[] = [
      userPrompt(),
      thinking(),
      textResponse("hello world"),
      toolCall("Read"),
    ];
    for (const scene of scenes) {
      const at1x = sceneDuration(scene, 1);
      const at4x = sceneDuration(scene, 4);
      expect(at4x).toBe(at1x / 4);
    }
  });
});
