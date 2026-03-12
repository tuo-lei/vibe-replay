import { describe, expect, it } from "vitest";
import { __testables, countComposerConversationHeaders } from "./sqlite-reader.js";

describe("countComposerConversationHeaders", () => {
  it("returns zero when headers are missing", () => {
    expect(countComposerConversationHeaders({})).toBe(0);
  });

  it("returns zero when headers are not an array", () => {
    expect(countComposerConversationHeaders({ fullConversationHeadersOnly: "oops" })).toBe(0);
  });

  it("returns array length for replayable composer payloads", () => {
    expect(
      countComposerConversationHeaders({
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }, { bubbleId: "c" }],
      }),
    ).toBe(3);
  });
});

describe("cursor sqlite metrics helpers", () => {
  it("computes token increments from cumulative snapshots", () => {
    const first = __testables.estimateTokenIncrement(
      {
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      undefined,
    );
    expect(first.increment).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    const second = __testables.estimateTokenIncrement(
      {
        inputTokens: 1500,
        outputTokens: 140,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      first.nextSnapshot,
    );
    expect(second.increment).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("handles token snapshot resets without negative deltas", () => {
    const reset = __testables.estimateTokenIncrement(
      {
        inputTokens: 120,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        inputTokens: 500,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    );
    expect(reset.increment).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("builds dense global-state turn stats aligned to user turns", () => {
    const metrics = __testables.buildGlobalStateMetrics(
      [
        {
          turn: { role: "user", blocks: [{ type: "text", text: "first prompt" }] },
          bubble: { type: 1, tokenCount: { inputTokens: 0, outputTokens: 0 } },
        },
        {
          turn: { role: "assistant", blocks: [{ type: "text", text: "first reply" }] },
          bubble: {
            type: 2,
            tokenCount: { inputTokens: 1000, outputTokens: 80 },
            modelInfo: { modelName: "claude-4.6-opus-high-thinking" },
          },
        },
        {
          turn: { role: "user", blocks: [{ type: "text", text: "second prompt" }] },
          bubble: { type: 1, tokenCount: { inputTokens: 0, outputTokens: 0 } },
        },
      ] as any,
      "claude-4.6-opus-high-thinking",
    );

    expect(metrics.turnStats).toHaveLength(2);
    expect(metrics.turnStats?.[0]?.tokenUsage?.outputTokens).toBe(80);
    expect(metrics.turnStats?.[1]?.tokenUsage).toBeUndefined();
  });

  it("builds dense store turn stats aligned to user turns", () => {
    const turnStats = __testables.buildStoreTurnStats([
      {
        role: "user",
        blocks: [{ type: "text", text: "first prompt" }],
      },
      {
        role: "assistant",
        model: "gpt-5.3-codex-high",
        blocks: [{ type: "tool_use", id: "1", name: "Bash", input: {}, _durationMs: 1200 } as any],
      },
      {
        role: "user",
        blocks: [{ type: "text", text: "second prompt" }],
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "plain reply without tool duration" }],
      },
    ] as any);

    expect(turnStats).toHaveLength(2);
    expect(turnStats[0]).toMatchObject({ turnIndex: 0, durationMs: 1200 });
    expect(turnStats[1]).toMatchObject({ turnIndex: 1 });
    expect(turnStats[1].durationMs).toBeUndefined();
  });
});
