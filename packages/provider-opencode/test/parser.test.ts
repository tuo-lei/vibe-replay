import { describe, expect, it } from "vitest";
import { parseSessionFromDb } from "../src/opencode/parser.js";
import { mapOpencodeToolArgs, mapOpencodeToolName } from "../src/opencode/tool-mapping.js";
import { buildOpencodeDb } from "./helpers/db.js";

const baseSession = {
  id: "ses_111",
  slug: "swift-eagle",
  title: "Add opencode support",
  directory: "/Users/test/project",
};

describe("opencode parser", () => {
  it("parses a user turn, reasoning, text, and tool blocks", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_u1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_001_000,
          parts: [{ type: "text", text: "Please add opencode support" }],
        },
        {
          id: "msg_a1",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_002_000,
          finish: "tool-calls",
          tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } },
          parts: [
            { type: "reasoning", text: "Let me inspect the provider architecture." },
            { type: "text", text: "I'll inspect the existing providers first." },
            {
              type: "tool",
              tool: "bash",
              callID: "call_1",
              state: {
                status: "completed",
                input: { command: "ls providers" },
                output: "cursor codex",
                time: { start: 1_800_000_002_100, end: 1_800_000_002_300 },
              },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");

      expect(result.sessionId).toBe("ses_111");
      expect(result.slug).toBe("swift-eagle");
      expect(result.title).toBe("Add opencode support");
      expect(result.cwd).toBe("/Users/test/project");
      expect(result.model).toBe("deepseek-v4-flash-free");
      expect(result.turns).toHaveLength(2);

      const user = result.turns[0];
      expect(user.role).toBe("user");
      expect(user.blocks[0]).toMatchObject({ type: "text", text: "Please add opencode support" });

      const assistant = result.turns[1];
      const blocks = assistant.blocks;
      expect(blocks[0]).toMatchObject({
        type: "thinking",
        thinking: "Let me inspect the provider architecture.",
      });
      expect(blocks[1]).toMatchObject({
        type: "text",
        text: "I'll inspect the existing providers first.",
      });

      const tool = blocks.find((b) => b.type === "tool_use");
      expect(tool).toMatchObject({
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "ls providers" },
        _result: "cursor codex",
        _durationMs: 200,
      });

      expect(result.tokenUsage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      expect(result.tokenUsageByModel?.["deepseek-v4-flash-free"]).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
      });
    } finally {
      db.close();
    }
  });

  it("reports the session's own cost as reportedCostUsd when positive", async () => {
    const withCost = await buildOpencodeDb({
      session: [{ ...baseSession, cost: 0.177 }],
      messages: [
        {
          id: "msg_u1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_001_000,
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    });
    try {
      const result = parseSessionFromDb(withCost, "ses_111");
      expect(result.reportedCostUsd).toBeCloseTo(0.177, 6);
    } finally {
      withCost.close();
    }

    const withoutCost = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_u1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_001_000,
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    });
    try {
      const result = parseSessionFromDb(withoutCost, "ses_111");
      expect(result.reportedCostUsd).toBeUndefined();
    } finally {
      withoutCost.close();
    }
  });

  it("maps edit/write/read tool args to snake_case fields", () => {
    expect(mapOpencodeToolName("edit")).toBe("Edit");
    expect(mapOpencodeToolName("bash")).toBe("Bash");
    expect(mapOpencodeToolName("task")).toBe("Agent");
    expect(mapOpencodeToolName("todo")).toBe("todo");

    expect(
      mapOpencodeToolArgs("edit", { filePath: "src/a.ts", oldString: "a", newString: "b" }),
    ).toEqual({ file_path: "src/a.ts", old_string: "a", new_string: "b" });

    expect(mapOpencodeToolArgs("write", { filePath: "src/b.ts", content: "hi" })).toEqual({
      file_path: "src/b.ts",
      content: "hi",
    });

    expect(mapOpencodeToolArgs("read", { filePath: "src/c.ts" })).toEqual({
      file_path: "src/c.ts",
    });
  });

  it("renders error/unknown-finish assistant turns with their last text", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_e",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_003_000,
          finish: "error",
          parts: [{ type: "text", text: "That failed with a permission error." }],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        role: "assistant",
        blocks: [{ type: "text", text: "That failed with a permission error." }],
      });
    } finally {
      db.close();
    }
  });

  it("retains concrete failed tool parts on an error finish", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_tool_error",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_003_500,
          finish: "error",
          parts: [
            {
              type: "tool",
              tool: "bash",
              callID: "call_error",
              state: { status: "error", input: { command: "false" }, output: "permission denied" },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      const tool = result.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use");
      expect(tool).toMatchObject({
        type: "tool_use",
        name: "Bash",
        _hasResult: true,
        _isError: true,
        _result: "permission denied",
      });
    } finally {
      db.close();
    }
  });

  it("marks running tool parts without dropping their call", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_r",
          sessionId: "ses_111",
          role: "assistant",
          timeCreated: 1_800_000_004_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "grep",
              callID: "call_2",
              state: { status: "running", input: { pattern: "build(" } },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      const tool = result.turns[0]?.blocks.find((b) => b.type === "tool_use");
      expect(tool).toMatchObject({ type: "tool_use", name: "Grep", input: { pattern: "build(" } });
    } finally {
      db.close();
    }
  });

  it("discards a placeholder running tool part when a completed part supersedes it", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_sp",
          sessionId: "ses_111",
          role: "assistant",
          timeCreated: 1_800_000_005_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "bash",
              callID: "call_3",
              state: { status: "running", input: { command: "pwd" } },
            },
            {
              type: "tool",
              tool: "bash",
              callID: "call_3",
              state: {
                status: "completed",
                input: { command: "pwd" },
                output: "/Users/test/project",
              },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      const tools = result.turns[0]?.blocks.filter((b) => b.type === "tool_use") ?? [];
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ _result: "/Users/test/project" });
      expect((tools[0] as any)._isPendingMarker).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("records compactions from synthetic user messages", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_c",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_006_000,
          parts: [{ type: "compaction", auto: true }],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.compactions).toMatchObject([{ trigger: "opencode-context" }]);
      expect(result.turns).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("extracts user-supplied images from opencode file parts", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_img",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_007_000,
          parts: [
            { type: "text", text: "See this screenshot" },
            { type: "file", url: "https://img.example/x.png", mime: "image/png" },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      const user = result.turns[0];
      expect(user.role).toBe("user");
      expect(user.blocks.find((b) => b.type === "_user_images")).toMatchObject({
        type: "_user_images",
        images: ["https://img.example/x.png"],
      });
    } finally {
      db.close();
    }
  });

  it("resolves interleaved running tool parts by callID", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_conc",
          sessionId: "ses_111",
          role: "assistant",
          timeCreated: 1_800_000_008_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "grep",
              callID: "call_a",
              state: { status: "running", input: { pattern: "a" } },
            },
            {
              type: "tool",
              tool: "read",
              callID: "call_b",
              state: { status: "running", input: { filePath: "x.ts" } },
            },
            {
              type: "tool",
              tool: "grep",
              callID: "call_a",
              state: { status: "completed", input: { pattern: "a" }, output: "a-matches" },
            },
            {
              type: "tool",
              tool: "read",
              callID: "call_b",
              state: { status: "completed", input: { filePath: "x.ts" }, output: "file body" },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      const tools = result.turns[0]?.blocks.filter((b) => b.type === "tool_use") ?? [];
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ id: "call_a", name: "Grep", _result: "a-matches" });
      expect((tools[0] as any)._isPendingMarker).toBeUndefined();
      expect(tools[1]).toMatchObject({ id: "call_b", name: "Read", _result: "file body" });
      expect((tools[1] as any)._isPendingMarker).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("reports parseWarnings for unparseable message data", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_bad",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_009_000,
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    });
    // Corrupt the stored message JSON directly to simulate a malformed row.
    db.run("UPDATE message SET data = 'not json{' WHERE id = 'msg_bad'");

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.turns).toHaveLength(0);
      expect(result.parseWarnings).toHaveLength(1);
      expect(result.parseWarnings?.[0]).toMatchObject({
        kind: "malformed-json",
        source: "opencode message",
        message: "message msg_bad: unparseable data, skipped",
      });
    } finally {
      db.close();
    }
  });

  it("marks AI-SDK 'length' finishes as truncated turns", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_len",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_010_000,
          finish: "length",
          parts: [{ type: "text", text: "Partial answer cut off mid-way" }],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.truncatedResponses).toBe(1);
      expect(result.turns[0]).toMatchObject({
        role: "assistant",
        stopReason: "max_tokens",
      });
    } finally {
      db.close();
    }
  });

  it("counts truncation even when the truncated message produced no blocks", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_len_empty",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_010_500,
          finish: "length",
          parts: [],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.truncatedResponses).toBe(1);
      expect(result.turns).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("records failed assistant finishes as privacy-safe apiErrors", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_err1",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_011_000,
          finish: "error",
          error: { name: "APIError" },
          parts: [{ type: "text", text: "" }],
        },
        {
          id: "msg_err2",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_012_000,
          finish: "error",
          // Prose stored where a name belongs is a message, not a type: never stored.
          error: { name: "429 too many requests: rate limit for prompt abc" },
          parts: [{ type: "text", text: "" }],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.apiErrors).toHaveLength(2);
      expect(result.apiErrors?.[0]).toMatchObject({ errorType: "APIError" });
      expect(result.apiErrors?.[1]).toEqual({
        timestamp: new Date(1_800_000_012_000).toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it("builds per-turn stats from assistant message usage", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_u1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_020_000,
          parts: [{ type: "text", text: "first prompt" }],
        },
        {
          id: "msg_a1",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "model-a",
          timeCreated: 1_800_000_021_000,
          tokens: { input: 100, output: 20, cache: { read: 40, write: 10 } },
          parts: [{ type: "text", text: "step one" }],
        },
        {
          id: "msg_a2",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "model-a",
          timeCreated: 1_800_000_023_000,
          tokens: { input: 200, output: 30 },
          parts: [{ type: "text", text: "step two" }],
        },
        {
          id: "msg_u2",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_026_000,
          parts: [{ type: "text", text: "second prompt" }],
        },
        {
          id: "msg_a3",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "model-b",
          timeCreated: 1_800_000_027_000,
          tokens: { input: 55, output: 5 },
          parts: [{ type: "text", text: "answer two" }],
        },
      ],
    });
    // Give two assistant messages a measurable active window.
    db.run("UPDATE message SET data = json_set(data, '$.time.completed', ?) WHERE id = ?", [
      1_800_000_022_000,
      "msg_a1",
    ]);
    db.run("UPDATE message SET data = json_set(data, '$.time.completed', ?) WHERE id = ?", [
      1_800_000_025_000,
      "msg_a2",
    ]);
    db.run("UPDATE message SET data = json_set(data, '$.time.completed', ?) WHERE id = ?", [
      1_800_000_028_000,
      "msg_a3",
    ]);

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.turnStats).toHaveLength(2);
      expect(result.turnStats?.[0]).toMatchObject({
        turnIndex: 0,
        model: "model-a",
        tokenUsage: {
          inputTokens: 300,
          outputTokens: 50,
          cacheReadTokens: 40,
          cacheCreationTokens: 10,
        },
        contextTokens: 200,
        durationMs: 3_000,
      });
      expect(result.turnStats?.[1]).toMatchObject({
        turnIndex: 1,
        model: "model-b",
        tokenUsage: { inputTokens: 55, outputTokens: 5 },
        durationMs: 1_000,
      });
    } finally {
      db.close();
    }
  });

  it("falls back to summed per-message cost when the session cost is missing", async () => {
    const db = await buildOpencodeDb({
      session: [{ ...baseSession, cost: 0 }],
      messages: [
        {
          id: "msg_c1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_030_000,
          parts: [{ type: "text", text: "cost me" }],
        },
        {
          id: "msg_c2",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_031_000,
          cost: 0.05,
          parts: [{ type: "text", text: "billed" }],
        },
        {
          id: "msg_c3",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_032_000,
          cost: 0.01,
          parts: [{ type: "text", text: "billed again" }],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.reportedCostUsd).toBeCloseTo(0.06, 6);
    } finally {
      db.close();
    }
  });

  it("attaches the spawned child session to its task tool call", async () => {
    const db = await buildOpencodeDb({
      session: [
        baseSession,
        {
          id: "ses_probe",
          slug: "probe",
          directory: "/Users/test/project",
          parentId: "ses_111",
        },
      ],
      messages: [
        {
          id: "msg_u1",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_040_000,
          parts: [{ type: "text", text: "Delegate a probe" }],
        },
        {
          id: "msg_a1",
          sessionId: "ses_111",
          role: "assistant",
          modelID: "deepseek-v4-flash-free",
          timeCreated: 1_800_000_041_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "task",
              callID: "call_task_1",
              state: {
                status: "completed",
                input: {
                  description: "Probe answer",
                  prompt: "Find the answer file",
                  subagent_type: "explore",
                },
                output: "answer: 42",
                metadata: {
                  parentSessionId: "ses_111",
                  sessionId: "ses_probe",
                  model: { modelID: "sub-model", providerID: "p" },
                },
                time: { start: 1_800_000_041_100, end: 1_800_000_043_000 },
              },
            },
          ],
        },
        {
          id: "msg_cu1",
          sessionId: "ses_probe",
          role: "user",
          timeCreated: 1_800_000_041_500,
          parts: [{ type: "text", text: "Find the answer file" }],
        },
        {
          id: "msg_ca1",
          sessionId: "ses_probe",
          role: "assistant",
          modelID: "sub-model",
          timeCreated: 1_800_000_042_000,
          tokens: { input: 10, output: 5 },
          finish: "tool-calls",
          parts: [
            { type: "reasoning", text: "Checking the project layout." },
            {
              type: "tool",
              tool: "read",
              callID: "call_sub_read",
              state: {
                status: "completed",
                input: { filePath: "answer.txt" },
                output: "file body",
                time: { start: 1_800_000_042_100, end: 1_800_000_042_400 },
              },
            },
            { type: "text", text: "answer: 42" },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.subAgentSummary).toEqual([
        {
          agentId: "ses_probe",
          agentType: "Explore",
          description: "Probe answer",
          toolCalls: 1,
          model: "sub-model",
        },
      ]);

      const agentBlock = result.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agentBlock).toBeDefined();
      const sub = (agentBlock as any)?._subAgent;
      expect(sub).toMatchObject({
        agentId: "ses_probe",
        agentType: "Explore",
        description: "Probe answer",
        prompt: "Find the answer file",
        toolCalls: 1,
        thinkingBlocks: 1,
        textResponses: 1,
        model: "sub-model",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
      });
      const toolScene = sub.scenes.find((scene: any) => scene.type === "tool-call");
      expect(toolScene).toMatchObject({
        toolName: "Read",
        input: { file_path: "answer.txt" },
        result: "file body",
        hasResult: true,
        isError: false,
        durationMs: 300,
      });
      expect(sub.usageEvents).toHaveLength(1);
      expect(sub.usageEvents[0]).toMatchObject({
        kind: "tool",
        name: "Read",
        status: "success",
        durationMs: 300,
      });
    } finally {
      db.close();
    }
  });

  it("leaves task calls without a child-session link as a bare Agent block", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_a_orphan",
          sessionId: "ses_111",
          role: "assistant",
          timeCreated: 1_800_000_045_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "task",
              callID: "call_task_orphan",
              state: {
                status: "completed",
                input: { description: "Legacy", prompt: "older format", subagent_type: "general" },
                output: "done",
              },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.subAgentSummary).toBeUndefined();
      const agentBlock = result.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use" && block.name === "Agent");
      expect(agentBlock).toBeDefined();
      expect((agentBlock as any)?._subAgent).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("drops synthetic text parts from user turns", async () => {
    const db = await buildOpencodeDb({
      session: [baseSession],
      messages: [
        {
          id: "msg_syn",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_050_000,
          parts: [{ type: "text", text: "INTERNAL reminder text", synthetic: true }],
        },
        {
          id: "msg_mix",
          sessionId: "ses_111",
          role: "user",
          timeCreated: 1_800_000_051_000,
          parts: [
            { type: "text", text: "note to the model", synthetic: true },
            { type: "text", text: "the real prompt" },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111");
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].blocks).toEqual([{ type: "text", text: "the real prompt" }]);
    } finally {
      db.close();
    }
  });

  it("attributes MCP tool calls via configured server names and reports the opened db", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "opencode-mcp-"));
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ mcp: { "zzz-mcp-test": { type: "remote", url: "https://x.test" } } }),
    );
    const db = await buildOpencodeDb({
      session: [{ ...baseSession, directory: dir }],
      messages: [
        {
          id: "msg_mcp",
          sessionId: "ses_111",
          role: "assistant",
          timeCreated: 1_800_000_060_000,
          finish: "tool-calls",
          parts: [
            {
              type: "tool",
              tool: "zzz-mcp-test_search_docs",
              callID: "call_mcp_1",
              state: {
                status: "completed",
                input: { query: "parity" },
                output: "doc hits",
              },
            },
            {
              type: "tool",
              tool: "unconfigured_unknown_call",
              callID: "call_mcp_2",
              state: { status: "completed", input: {}, output: "ok" },
            },
          ],
        },
      ],
    });

    try {
      const result = parseSessionFromDb(db, "ses_111", undefined, "/data/custom/opencode.db");
      const tools = result.turns.flatMap((turn) =>
        turn.blocks.filter((block) => block.type === "tool_use"),
      );
      expect(tools[0]).toMatchObject({
        name: "zzz-mcp-test_search_docs",
        _mcpServer: "zzz-mcp-test",
        _mcpTool: "search_docs",
      });
      expect(result.mcpServersUsed).toEqual(["zzz-mcp-test"]);
      // Unknown tools stay plain tool calls.
      expect(tools[1]).toMatchObject({ name: "unconfigured_unknown_call" });
      expect((tools[1] as any)._mcpServer).toBeUndefined();
      expect(result.dataSourceInfo?.sources).toEqual(["/data/custom/opencode.db"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
