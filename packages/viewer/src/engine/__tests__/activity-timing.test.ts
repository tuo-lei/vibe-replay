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

  it("estimates compaction time from the preceding gap", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      { type: "text-response", content: "Before", timestamp: timestamp(1) },
      { type: "compaction-summary", content: "Summary", timestamp: timestamp(5) },
      { type: "text-response", content: "After", timestamp: timestamp(6) },
    ]);

    expect(result.contextBoundaries).toEqual([
      { sceneIndex: 2, elapsedMs: 5_000, type: "compaction-summary", durationMs: 4_000 },
    ]);
    expect(
      result.intervals.map((interval) => [interval.kind, interval.durationMs, interval.note]),
    ).toEqual([
      ["llm-wait", 1_000, undefined],
      ["context", 4_000, "compaction-duration-estimate"],
      ["llm-wait", 1_000, undefined],
    ]);
    expect(result.compactionDurationMs).toBe(4_000);
  });

  it("keeps context injections as marker-only boundaries", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      { type: "text-response", content: "Before", timestamp: timestamp(1) },
      { type: "context-injection", content: "Injected context", timestamp: timestamp(5) },
      { type: "text-response", content: "After", timestamp: timestamp(6) },
    ]);

    expect(result.contextBoundaries).toEqual([
      { sceneIndex: 2, elapsedMs: 5_000, type: "context-injection" },
    ]);
    expect(result.compactionDurationMs).toBe(0);
    expect(result.intervals[1]).toMatchObject({
      kind: "unknown",
      durationMs: 4_000,
      note: "context-boundary",
    });
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

  it("excludes idle time after an unmeasured tool before a later user prompt", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Start", timestamp: timestamp(0) },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "ok",
        timestamp: timestamp(1),
      },
      { type: "user-prompt", content: "Continue", timestamp: timestamp(30) },
    ]);

    expect(result.totalMs).toBe(1_000);
    expect(result.excludedIdleMs).toBe(29_000);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].kind).toBe("llm-wait");
  });

  it("merges overlapping parallel tool durations instead of serializing them", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Run both", timestamp: timestamp(0) },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "one",
        timestamp: timestamp(1),
        durationMs: 5_000,
      },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm lint" },
        result: "two",
        timestamp: timestamp(1),
        durationMs: 5_000,
      },
      { type: "text-response", content: "Done", timestamp: timestamp(7) },
    ]);

    expect(result.toolCalls).toBe(2);
    expect(result.toolDurationMs).toBe(5_000);
    expect(result.totalMs).toBe(7_000);
  });

  it("anchors result-only tool durations at their end timestamp", () => {
    const result = buildActivityTiming([
      { type: "user-prompt", content: "Run command", timestamp: timestamp(0) },
      {
        type: "tool-call",
        toolName: "exec_command",
        input: { command: "pnpm test" },
        result: "ok",
        timestamp: timestamp(5),
        durationMs: 5_000,
        durationAnchor: "end",
      },
      { type: "text-response", content: "Done", timestamp: timestamp(6) },
    ]);

    expect(result.intervals.map((interval) => [interval.kind, interval.durationMs])).toEqual([
      ["tool", 5_000],
      ["llm-wait", 1_000],
    ]);
    expect(result.totalMs).toBe(6_000);
  });

  it("classifies file tools and canonical web tools in scope totals", () => {
    const result = buildActivityTiming([
      {
        type: "tool-call",
        toolName: "cat",
        input: { command: "cat package.json" },
        result: "{}",
        timestamp: timestamp(0),
        durationMs: 1_000,
      },
      {
        type: "tool-call",
        toolName: "WebFetch",
        input: { url: "https://example.com" },
        result: "ok",
        timestamp: timestamp(2),
        durationMs: 1_000,
      },
    ]);

    expect(result.toolCategories.file).toEqual({ durationMs: 1_000, count: 1 });
    expect(result.remoteToolMs).toBe(1_000);
  });

  it("uses whole-turn timing instead of misleading unknown gaps for Cursor/Codex", () => {
    const result = buildActivityTiming(
      [
        { type: "user-prompt", content: "Inspect", timestamp: timestamp(0) },
        {
          type: "tool-call",
          toolName: "run_terminal_command_v2",
          input: { command: "pnpm test" },
          result: "ok",
          timestamp: timestamp(1),
        },
        { type: "text-response", content: "Done", timestamp: timestamp(10) },
      ],
      { provider: "cursor", turnStats: [{ turnIndex: 0, durationMs: 3_000 }] },
    );

    expect(result.timingMode).toBe("provider-turns");
    expect(result.providerTurnDurationMs).toBe(3_000);
    expect(result.totalMs).toBe(3_000);
    expect(result.intervals).toEqual([
      expect.objectContaining({
        kind: "agent-turn",
        durationMs: 3_000,
        source: "turn-duration",
      }),
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
