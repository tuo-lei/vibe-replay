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
});
