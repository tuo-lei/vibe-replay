import { describe, expect, it } from "vitest";
import { buildActivityTiming } from "../activity-timing";

const timestamp = (seconds: number) =>
  `2026-08-31T00:00:${seconds.toString().padStart(2, "0")}.000Z`;

describe("buildActivityTiming", () => {
  it("keeps user idle, model gaps, tool time, and response gaps non-overlapping", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "ok",
        timestamp: timestamp(1),
        durationMs: 2_000,
      },
      { type: "thinking", content: "Reason", timestamp: timestamp(4) },
      { type: "text-response", content: "Done", timestamp: timestamp(5) },
      { type: "user-prompt", content: "Thanks", timestamp: timestamp(10) },
    ]);

    expect(result.intervals.map((interval) => [interval.kind, interval.durationMs])).toEqual([
      ["llm-wait", 1_000],
      ["tool", 2_000],
      ["llm-wait", 1_000],
      ["response", 1_000],
    ]);
    expect(result.totalMs).toBe(5_000);
    expect(result.timestampGapMs).toBe(3_000);
    expect(result.excludedIdleMs).toBe(5_000);
    expect(result.toolDurationMs).toBe(2_000);
    expect(result.localToolMs).toBe(2_000);
    expect(result.toolCategories.test).toEqual({ durationMs: 2_000, count: 1 });
  });

  it("does not pretend a context boundary has a duration", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      { type: "text-response", content: "Before", timestamp: timestamp(1) },
      { type: "compaction-summary", content: "Summary", timestamp: timestamp(5) },
      { type: "text-response", content: "After", timestamp: timestamp(6) },
    ]);

    expect(result.contextBoundaries).toEqual([
      { sceneIndex: 2, elapsedMs: 5_000, type: "compaction-summary" },
    ]);
    expect(
      result.intervals.map((interval) => [interval.kind, interval.durationMs, interval.note]),
    ).toEqual([
      ["llm-wait", 1_000, undefined],
      ["unknown", 4_000, "context-boundary"],
      ["llm-wait", 1_000, undefined],
    ]);
  });

  it("does not double-count a gap after a tool with no recorded duration", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "ok",
        timestamp: timestamp(1),
      },
      { type: "text-response", content: "Done", timestamp: timestamp(5) },
    ]);

    expect(result.totalMs).toBe(5_000);
    expect(result.toolDurationMs).toBe(0);
    expect(result.unmeasuredToolCalls).toBe(1);
    expect(
      result.intervals.map((interval) => [interval.kind, interval.durationMs, interval.note]),
    ).toEqual([
      ["llm-wait", 1_000, undefined],
      ["unknown", 4_000, "unmeasured-tool"],
    ]);
  });

  it("keeps known tool time when no scene timestamps exist", () => {
    const result = buildActivityTiming([
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm lint" },
        result: "ok",
        durationMs: 3_000,
      },
      { type: "text-response", content: "Done" },
    ]);

    expect(result.totalMs).toBe(3_000);
    expect(result.toolDurationMs).toBe(3_000);
    expect(result.timestampGapMs).toBe(0);
    expect(result.toolCategories.lint).toEqual({ durationMs: 3_000, count: 1 });
  });
});
