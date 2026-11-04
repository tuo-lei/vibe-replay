import { expect, it } from "vitest";
import { diagnoseSession, inspectSession } from "../src/session-workflows.js";
import type { ReplaySession } from "../src/types.js";

it("distinguishes observed failures from unavailable results, excluding wrapper containers", () => {
  const replay = {
    meta: {
      sessionId: "partial",
      provider: "codex",
      stats: { sceneCount: 5, toolCalls: 4, userPrompts: 1, thinkingBlocks: 0 },
      dataSourceInfo: { primary: "jsonl", sources: [], notes: ["Nested results unavailable."] },
    },
    scenes: [
      {
        type: "tool-call",
        toolName: "exec",
        input: {},
        isToolContainer: true,
        result: "Wrapper output",
        hasResult: true,
      },
      { type: "tool-call", toolName: "Bash", input: {}, hasResult: false, isError: false },
      {
        type: "tool-call",
        toolName: "Bash",
        input: {},
        result: "",
        hasResult: true,
        isError: false,
      },
      { type: "tool-call", toolName: "Bash", input: {}, result: "Failed", isError: true },
      { type: "tool-call", toolName: "Read", input: {} },
    ],
  } as ReplaySession;
  for (const result of [inspectSession(replay), diagnoseSession(replay)]) {
    expect(result.toolResultCoverage).toEqual({
      total: 4,
      available: 2,
      unavailable: 2,
      complete: false,
    });
    expect(result.dataQualityNotes).toEqual([
      "Nested results unavailable.",
      "2 of 4 tool calls have no recorded result; zero observed tool errors does not establish that those calls succeeded.",
    ]);
  }
  expect(diagnoseSession(replay).toolErrorCount).toBe(1);
});

it("does not create a missing-result warning for complete or tool-free sessions", () => {
  const replay = {
    meta: {
      sessionId: "complete",
      provider: "pi",
      stats: { sceneCount: 1, toolCalls: 1, userPrompts: 0, thinkingBlocks: 0 },
    },
    scenes: [{ type: "tool-call", toolName: "Read", input: {}, result: "", hasResult: true }],
  } as ReplaySession;
  expect(diagnoseSession(replay).toolResultCoverage).toEqual({
    total: 1,
    available: 1,
    unavailable: 0,
    complete: true,
  });
  expect(diagnoseSession(replay).dataQualityNotes).toEqual([]);
  expect(diagnoseSession({ ...replay, scenes: [] }).toolResultCoverage).toEqual({
    total: 0,
    available: 0,
    unavailable: 0,
    complete: true,
  });
});
