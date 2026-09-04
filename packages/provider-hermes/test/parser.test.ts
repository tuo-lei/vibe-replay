import { describe, expect, it } from "vitest";
import { parseSessionFromDb } from "../src/hermes/parser.js";
import { hermesProfileDir } from "../src/hermes/sqlite.js";
import { mapHermesToolArgs, mapHermesToolName } from "../src/hermes/tool-mapping.js";
import { buildHermesDb, toolCallsFor } from "./helpers/db.js";

const baseSession = {
  id: "20260804_202053_7b0f72",
  title: "Add Hermes support",
  cwd: "/Users/test/project",
  model: "deepseek-v4-flash-free",
};

describe("hermes parser", () => {
  it("parses user/assistant/tool turns with thinking, text, and mapped tool blocks", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "Please add Hermes support",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "assistant",
          reasoningContent: "Let me inspect the provider architecture.",
          content: "I'll inspect the existing providers first.",
          toolCalls: toolCallsFor([
            { id: "call_1", name: "terminal", args: { command: "ls providers" } },
          ]),
          finishReason: "tool_calls",
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "call_1",
          content: "cursor codex",
          timestamp: 1_800_000_003,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);

      expect(result.sessionId).toBe(baseSession.id);
      expect(result.slug).toBe(baseSession.id);
      expect(result.title).toBe("Add Hermes support");
      expect(result.cwd).toBe("/Users/test/project");
      expect(result.model).toBe("deepseek-v4-flash-free");
      expect(result.turns).toHaveLength(2);

      const user = result.turns[0];
      expect(user.role).toBe("user");
      expect(user.blocks[0]).toMatchObject({ type: "text", text: "Please add Hermes support" });

      const assistant = result.turns[1];
      expect(assistant.blocks[0]).toMatchObject({
        type: "thinking",
        thinking: "Let me inspect the provider architecture.",
      });
      expect(assistant.blocks[1]).toMatchObject({
        type: "text",
        text: "I'll inspect the existing providers first.",
      });

      const tool = assistant.blocks.find((b) => b.type === "tool_use");
      expect(tool).toMatchObject({
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "ls providers" },
        _result: "cursor codex",
        _durationMs: 1000,
        _durationSource: "timestamp",
        _durationAnchor: "start",
      });

      expect(result.startTime).toBe("2027-01-15T08:00:01.000Z");
      expect(result.endTime).toBe("2027-01-15T08:00:03.000Z");
      expect(result.dataSource).toBe("sqlite");
      expect(result.dataSourceInfo?.primary).toBe("sqlite");
    } finally {
      db.close();
    }
  });

  it("parses older databases without optional compaction and model-usage schema", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "Parse this legacy database",
          timestamp: 1_800_000_001,
        },
      ],
    });
    db.run("ALTER TABLE messages DROP COLUMN compacted");
    db.run("DROP TABLE session_model_usage");

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]?.blocks[0]).toMatchObject({
        type: "text",
        text: "Parse this legacy database",
      });
      expect(result.compactions).toBeUndefined();
      expect(result.tokenUsageByModel).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("aggregates token usage from session and per-model rows", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          ...baseSession,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hi",
          timestamp: 1_800_000_001,
        },
      ],
      modelUsage: [
        {
          sessionId: baseSession.id,
          model: "deepseek-v4-flash-free",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.tokenUsage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
      });
      expect(result.tokenUsageByModel?.["deepseek-v4-flash-free"]).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
      });
    } finally {
      db.close();
    }
  });

  it("sums duplicate per-model rows from separate billing dimensions", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hello",
          timestamp: 1_800_000_001,
        },
      ],
      modelUsage: [
        {
          sessionId: baseSession.id,
          model: baseSession.model,
          inputTokens: 100,
          outputTokens: 20,
        },
      ],
    });
    db.run(
      `INSERT INTO session_model_usage (
        session_id, model, billing_provider, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?)`,
      [baseSession.id, baseSession.model, "fallback-provider", 40, 8],
    );

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.tokenUsageByModel?.[baseSession.model]).toMatchObject({
        inputTokens: 140,
        outputTokens: 28,
      });
    } finally {
      db.close();
    }
  });

  it("prefers actual_cost_usd over estimated_cost_usd for reportedCostUsd", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hello",
          timestamp: 1_800_000_001,
        },
      ],
    });
    db.run("UPDATE sessions SET actual_cost_usd = 0.42, estimated_cost_usd = 0.5 WHERE id = ?", [
      baseSession.id,
    ]);

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.reportedCostUsd).toBe(0.42);
    } finally {
      db.close();
    }
  });

  it("falls back to estimated_cost_usd when no actual cost is recorded", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hello",
          timestamp: 1_800_000_001,
        },
      ],
    });
    db.run("UPDATE sessions SET estimated_cost_usd = 0.24 WHERE id = ?", [baseSession.id]);

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.reportedCostUsd).toBe(0.24);
    } finally {
      db.close();
    }
  });

  it("omits reportedCostUsd when hermes reports zero cost", async () => {
    const db = await buildHermesDb({
      sessions: [{ ...baseSession, inputTokens: 10, outputTokens: 5 }],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hello",
          timestamp: 1_800_000_001,
        },
      ],
    });
    // Hermes stores 0 for cost_status 'included' / 'unknown'.
    db.run("UPDATE sessions SET estimated_cost_usd = 0, actual_cost_usd = NULL WHERE id = ?", [
      baseSession.id,
    ]);

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.reportedCostUsd).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("records every compaction boundary, not just the first", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "first prompt",
          compacted: 1,
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "assistant",
          content: "first answer",
          compacted: 1,
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] summary one",
          timestamp: 1_800_000_003,
        },
        {
          id: 4,
          sessionId: baseSession.id,
          role: "user",
          content: "second prompt",
          timestamp: 1_800_000_004,
        },
        {
          id: 5,
          sessionId: baseSession.id,
          role: "assistant",
          content: "second answer",
          compacted: 1,
          timestamp: 1_800_000_005,
        },
        {
          id: 6,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "call_c2",
          content: "{}",
          compacted: 1,
          timestamp: 1_800_000_006,
        },
        {
          id: 7,
          sessionId: baseSession.id,
          role: "user",
          content: "third prompt",
          timestamp: 1_800_000_007,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      // Each contiguous compacted run collapses into exactly one event.
      expect(result.compactions).toHaveLength(2);
      expect(result.compactions?.[0].timestamp).toBe("2027-01-15T08:00:01.000Z");
      expect(result.compactions?.[1].timestamp).toBe("2027-01-15T08:00:05.000Z");
    } finally {
      db.close();
    }
  });

  it("pairs parallel tool calls with their results by call id", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([
            { id: "call_a", name: "search_files", args: { pattern: "foo", path: "src" } },
            { id: "call_b", name: "read_file", args: { path: "src/x.ts" } },
          ]),
          finishReason: "tool_calls",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "search_files",
          toolCallId: "call_a",
          content: "matches-a",
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "read_file",
          toolCallId: "call_b",
          content: "file body",
          timestamp: 1_800_000_003,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      const tools = result.turns[0]?.blocks.filter((b) => b.type === "tool_use") ?? [];
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ id: "call_a", name: "Grep", _result: "matches-a" });
      expect(tools[1]).toMatchObject({ id: "call_b", name: "Read", _result: "file body" });
    } finally {
      db.close();
    }
  });

  it("maps Hermes tool names onto the viewer vocabulary", () => {
    expect(mapHermesToolName("terminal")).toBe("Bash");
    expect(mapHermesToolName("write_file")).toBe("Write");
    expect(mapHermesToolName("patch")).toBe("Edit");
    expect(mapHermesToolName("delegate_task")).toBe("Agent");
    expect(mapHermesToolName("clarify")).toBe("AskQuestion");
    expect(mapHermesToolName("unknown_tool")).toBe("unknown_tool");

    expect(
      mapHermesToolArgs("patch", { path: "src/a.ts", old_string: "a", new_string: "b" }),
    ).toEqual({
      file_path: "src/a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(mapHermesToolArgs("write_file", { path: "src/b.ts", content: "hi" })).toEqual({
      file_path: "src/b.ts",
      content: "hi",
    });
    expect(mapHermesToolArgs("read_file", { path: "src/c.ts" })).toEqual({
      file_path: "src/c.ts",
    });
    expect(mapHermesToolArgs("terminal", { command: "pwd" })).toEqual({ command: "pwd" });
    expect(mapHermesToolArgs("delegate_task", { goal: "g", context: "c" })).toMatchObject({
      description: "g",
      prompt: "c",
      subagent_type: "subagent",
    });
  });

  it("skips session_meta and empty user rows, preserves orphan tool results", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        { id: 1, sessionId: baseSession.id, role: "session_meta", timestamp: 1_800_000_001 },
        { id: 2, sessionId: baseSession.id, role: "user", content: "", timestamp: 1_800_000_002 },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "user",
          content: "real prompt",
          timestamp: 1_800_000_003,
        },
        {
          id: 4,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "missing_call",
          content: "orphan",
          timestamp: 1_800_000_004,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0]).toMatchObject({
        role: "user",
        blocks: [{ type: "text", text: "real prompt" }],
      });
      expect(result.turns[1]).toMatchObject({
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "missing_call",
            name: "Bash",
            _hasResult: true,
            _result: "orphan",
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("records a compaction event when rows are marked compacted", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "early prompt",
          compacted: 1,
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "user",
          content: "post-compaction summary",
          timestamp: 1_800_000_002,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.compactions).toHaveLength(1);
      expect(result.compactions?.[0]).toMatchObject({ trigger: "hermes-compaction" });
      // Compacted history stays in the replay; the summary renders as a user turn.
      expect(result.turns).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("marks context-compaction summary rows as compaction-summary turns", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.",
          timestamp: 1_800_000_001,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        role: "user",
        subtype: "compaction-summary",
      });
    } finally {
      db.close();
    }
  });

  it("records compaction metadata from summary-only rows", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] More turns were compacted.",
          timestamp: 1_800_000_002,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.compactions).toEqual([
        {
          timestamp: "2027-01-15T08:00:01.000Z",
          trigger: "hermes-compaction-summary",
        },
        {
          timestamp: "2027-01-15T08:00:02.000Z",
          trigger: "hermes-compaction-summary",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("counts truncated responses and collects skill names", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          content: "cut off",
          finishReason: "max_tokens",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([
            { id: "call_s", name: "skill_view", args: { name: " replay " } },
          ]),
          finishReason: "tool_calls",
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "skill_view",
          toolCallId: "call_s",
          content: "skill content",
          timestamp: 1_800_000_003,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.truncatedResponses).toBe(1);
      expect(result.skillsUsed).toEqual(["replay"]);
    } finally {
      db.close();
    }
  });

  it("reports parseWarnings for unparseable tool_calls", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: { id: "call_x" },
          timestamp: 1_800_000_001,
        },
      ],
    });
    // Corrupt the stored tool_calls JSON directly to simulate a malformed row.
    db.run("UPDATE messages SET tool_calls = 'not json{' WHERE id = 1");

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.turns).toHaveLength(0);
      expect(result.parseWarnings).toHaveLength(1);
      expect(result.parseWarnings?.[0]).toMatchObject({
        kind: "malformed-json",
        source: "hermes message",
      });
    } finally {
      db.close();
    }
  });

  it("reports the producing database path in dataSourceInfo when provided", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "profile session prompt",
          timestamp: 1_800_000_001,
        },
      ],
    });

    try {
      const profileDbPath = "/Users/test/.hermes/profiles/codex/state.db";
      const result = parseSessionFromDb(db, baseSession.id, undefined, profileDbPath);
      expect(result.dataSourceInfo?.sources).toEqual([profileDbPath]);
    } finally {
      db.close();
    }
  });

  it("infers tool duration from assistant and tool timestamps for activity insights", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([
            { id: "call_dur1", name: "terminal", args: { command: "sleep 1" } },
          ]),
          timestamp: 1_800_000_002,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "call_dur1",
          content: "done",
          timestamp: 1_800_000_003,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([{ id: "call_dur2", name: "read_file", args: { path: "a.ts" } }]),
          timestamp: 1_800_000_004,
        },
        {
          id: 4,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "read_file",
          toolCallId: "call_dur2",
          content: "file content",
          timestamp: 1_800_000_004.5,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      const tools = result.turns.flatMap((turn) =>
        turn.blocks.filter((block) => block.type === "tool_use"),
      ) as Array<Extract<(typeof result.turns)[number]["blocks"][number], { type: "tool_use" }>>;
      expect(tools).toHaveLength(2);
      expect(tools[0]._durationMs).toBe(1000);
      expect(tools[0]._durationSource).toBe("timestamp");
      expect(tools[0]._durationAnchor).toBe("start");
      expect(tools[1]._durationMs).toBe(500);
    } finally {
      db.close();
    }
  });

  it("does not assign tool duration when timestamps would imply an unrealistic gap", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([{ id: "call_long", name: "terminal", args: { command: "x" } }]),
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "call_long",
          content: "done",
          timestamp: 1_800_000_001 + 60 * 60, // 1 hour later — should be treated as idle, not tool time
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      const tool = result.turns.flatMap((turn) =>
        turn.blocks.filter((block) => block.type === "tool_use"),
      )[0] as Extract<(typeof result.turns)[number]["blocks"][number], { type: "tool_use" }>;
      expect(tool._durationMs).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("does not assign tool duration for same-second or exactly 30-minute gaps", async () => {
    const db = await buildHermesDb({
      sessions: [baseSession],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([{ id: "call_same", name: "terminal", args: { command: "x" } }]),
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "terminal",
          toolCallId: "call_same",
          content: "done",
          timestamp: 1_800_000_001,
        },
        {
          id: 3,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([{ id: "call_cap", name: "read_file", args: { path: "a.ts" } }]),
          timestamp: 1_800_000_010,
        },
        {
          id: 4,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "read_file",
          toolCallId: "call_cap",
          content: "body",
          timestamp: 1_800_000_010 + 30 * 60,
        },
        {
          id: 5,
          sessionId: baseSession.id,
          role: "assistant",
          toolCalls: toolCallsFor([
            { id: "call_under", name: "search_files", args: { pattern: "a" } },
          ]),
          timestamp: 1_800_000_100,
        },
        {
          id: 6,
          sessionId: baseSession.id,
          role: "tool",
          toolName: "search_files",
          toolCallId: "call_under",
          content: "matches",
          timestamp: 1_800_000_100 + 30 * 60 - 1,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      const tools = result.turns.flatMap((turn) =>
        turn.blocks.filter((block) => block.type === "tool_use"),
      ) as Array<Extract<(typeof result.turns)[number]["blocks"][number], { type: "tool_use" }>>;
      expect(tools).toHaveLength(3);
      expect(tools[0]._durationMs).toBeUndefined();
      expect(tools[1]._durationMs).toBeUndefined();
      expect(tools[2]._durationMs).toBe((30 * 60 - 1) * 1000);
    } finally {
      db.close();
    }
  });

  it("uses the Hermes profile directory as cwd for Bot Chat sessions", async () => {
    const db = await buildHermesDb({
      sessions: [{ ...baseSession, cwd: "", profileName: "ru" }],
      messages: [
        {
          id: 1,
          sessionId: baseSession.id,
          role: "user",
          content: "hello bot",
          timestamp: 1_800_000_001,
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, baseSession.id);
      expect(result.cwd).toBe(hermesProfileDir("ru"));
    } finally {
      db.close();
    }
  });
});
