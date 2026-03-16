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
  it("retries async initializer after a failure", async () => {
    let calls = 0;
    const init = __testables.createRetryableInit(async () => {
      calls++;
      if (calls === 1) throw new Error("init failed");
      return "ok";
    });

    await expect(init()).rejects.toThrow("init failed");
    await expect(init()).resolves.toBe("ok");
    await expect(init()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

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

  it("treats empty store roots as non-replayable", () => {
    expect(__testables.hasReplayableRootBlob(new Uint8Array())).toBe(false);
    expect(__testables.hasReplayableRootBlob(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });

  it("detects replayable store roots with linked child blob ids", () => {
    const replayableRoot = new Uint8Array([
      0xff,
      0x0a,
      0x20,
      ...Array.from({ length: 32 }, (_, i) => i + 1),
      0xee,
    ]);
    expect(__testables.hasReplayableRootBlob(replayableRoot)).toBe(true);
  });

  it("drops system context wrapped in user_query from sqlite user content", () => {
    const blocks = __testables.parseUserContent(
      "<user_query>\n<system_reminder>\ninternal only\n</system_reminder>\n</user_query>",
    );
    expect(blocks).toEqual([]);
  });

  it("keeps normal user_query content from sqlite user content", () => {
    const blocks = __testables.parseUserContent(
      "<user_query>\nShip this fix\n</user_query>",
    ) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("Ship this fix");
  });
});
