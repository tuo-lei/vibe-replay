import initSqlJs, { type Database } from "sql.js";
import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@vibe-replay/provider-contract";
import { listSessionsFromDb } from "../src/opencode/discover.js";
import { parseSessionFromDb } from "../src/opencode/parser.js";

async function v2Db(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, title TEXT, directory TEXT, version TEXT, model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);`);
  for (const [id, parent] of [
    ["ses_parent", null],
    ["ses_child", "ses_parent"],
  ]) {
    db.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      parent,
      id,
      "Build fix",
      "/repo",
      "2.0.22",
      JSON.stringify({ id: "model-v2", providerID: "test" }),
      0.5,
      1800000000000,
      1800000010000,
    ]);
  }
  return db;
}

function add(
  db: Database,
  id: string,
  type: string,
  seq: number,
  data: object,
  session = "ses_parent",
) {
  db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    session,
    type,
    seq,
    1800000000000 + seq * 1000,
    JSON.stringify({ time: { created: 1800000000000 + seq * 1000 }, ...data }),
  ]);
}

describe("OpenCode v2 storage compatibility", () => {
  it("discovers real prompts, counts tools/compactions, and keeps system/synthetic messages and children out of the picker", async () => {
    const db = await v2Db();
    try {
      add(db, "system", "system", 0, { text: "Internal instructions" });
      add(db, "synthetic", "synthetic", 1, { text: "Generated continuation" });
      add(db, "u1", "user", 2, { text: "Fix the failed build", files: [] });
      add(db, "a1", "assistant", 3, {
        model: { id: "model-v2" },
        content: [
          {
            type: "tool",
            id: "call1",
            name: "edit",
            state: {
              status: "completed",
              input: { filePath: "/repo/a.ts", oldString: "old", newString: "new" },
              content: [{ type: "text", text: "updated" }],
            },
            time: { created: 1800000003000, ran: 1800000003100, completed: 1800000003600 },
          },
        ],
      });
      add(db, "compact", "compaction", 4, {
        reason: "manual",
        summary: "Summary",
        recent: "Recent",
      });
      add(db, "child-u", "user", 0, { text: "Check tests" }, "ses_child");
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "ses_parent",
        firstPrompt: "Fix the failed build",
        promptCount: 1,
        toolCallCount: 1,
        editCountEst: 1,
        compactionCount: 1,
        model: "model-v2",
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(parsed.compactions).toEqual([
        { timestamp: "2027-01-15T08:00:04.000Z", trigger: "opencode-user" },
      ]);
      expect(parsed.turns[1].blocks[0]).toMatchObject({
        type: "tool_use",
        id: "call1",
        name: "Edit",
        _result: "updated",
        _durationMs: 500,
      });
    } finally {
      db.close();
    }
  });

  it("preserves reasoning, failed tool output, usage, model, images, and privacy-safe API errors", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, {
        text: "Review",
        files: [{ uri: "data:image/png;base64,abcd", mime: "image/png", name: "demo.png" }],
      });
      add(db, "a", "assistant", 1, {
        model: { id: "model-v2" },
        finish: "error",
        error: { type: "APIError", message: "SECRET ERROR TEXT" },
        time: { created: 1800000001000, completed: 1800000002000 },
        tokens: { input: 10, output: 20, cache: { read: 30, write: 40 } },
        content: [
          { type: "reasoning", text: "Investigate" },
          {
            type: "tool",
            id: "bad",
            name: "bash",
            state: {
              status: "error",
              input: { command: "pnpm test" },
              content: [{ type: "text", text: "tests failed" }],
            },
            time: { created: 1800000001000, completed: 1800000001500 },
          },
          { type: "text", text: "The build failed" },
        ],
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.turns[0].blocks).toContainEqual({
        type: "_user_images",
        images: ["data:image/png;base64,abcd"],
      });
      expect(parsed.turns[1].blocks).toContainEqual({ type: "thinking", thinking: "Investigate" });
      expect(parsed.turns[1].blocks[1]).toMatchObject({
        type: "tool_use",
        name: "Bash",
        _isError: true,
        _result: "tests failed",
      });
      expect(parsed.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      });
      expect(parsed.reportedCostUsd).toBe(0.5);
      expect(parsed.apiErrors).toEqual([
        { timestamp: "2027-01-15T08:00:02.000Z", errorType: "APIError" },
      ]);
      expect(JSON.stringify(parsed.apiErrors)).not.toContain("SECRET ERROR TEXT");
    } finally {
      db.close();
    }
  });

  it("reports malformed v2 records and rejects unknown schemas", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, { text: "Hello" });
      db.run(
        "INSERT INTO session_message VALUES ('bad', 'ses_parent', 'assistant', 1, 1800000001000, '{broken')",
      );
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.parseWarnings?.[0]).toMatchObject({ kind: "malformed-json", count: 1 });
    } finally {
      db.close();
    }
    const SQL = await initSqlJs();
    const unknown = new SQL.Database();
    try {
      expect(() => listSessionsFromDb(unknown)).toThrow("Unsupported OpenCode database schema");
    } finally {
      unknown.close();
    }
  });

  it("prefers active v2 sessions while leaving coexisting legacy tables intact", async () => {
    const db = await v2Db();
    try {
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO session (id) VALUES ('frozen-legacy');`);
      add(db, "v2-user", "user", 0, { text: "New v2 request" });
      const sessions = listSessionsFromDb(db);
      expect(sessions.map((s) => s.sessionId)).toEqual(["ses_parent"]);
      expect(sessions[0].firstPrompt).toBe("New v2 request");
      expect(parseSessionFromDb(db, "ses_parent").turns[0].blocks[0]).toEqual({
        type: "text",
        text: "New v2 request",
      });
      expect(db.exec("SELECT id FROM main.session")[0].values).toEqual([["frozen-legacy"]]);
      expect(db.exec("SELECT count(*) FROM main.message")[0].values).toEqual([[0]]);
    } finally {
      db.close();
    }
  });

  it("retains legacy-only sessions and uses v2 content for duplicate session IDs", async () => {
    const db = await v2Db();
    try {
      db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
      for (const id of ["legacy-only", "ses_parent"]) {
        db.run(
          "INSERT INTO main.session VALUES (?, ?, 'Legacy task', '/repo', 1800000000000, 1800000000000)",
          [id, id],
        );
        db.run("INSERT INTO main.message VALUES (?, ?, 1800000000000, ?)", [
          `old-${id}`,
          id,
          JSON.stringify({ role: "user", time: { created: 1800000000000 } }),
        ]);
        db.run("INSERT INTO main.part VALUES (?, ?, ?, 1800000000000, ?)", [
          `part-${id}`,
          `old-${id}`,
          id,
          JSON.stringify({ type: "text", text: `Legacy ${id}` }),
        ]);
      }
      add(db, "new", "user", 0, { text: "Active v2 request" });
      const sessions = listSessionsFromDb(db);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["legacy-only", "ses_parent"]);
      expect(sessions.find((s) => s.sessionId === "ses_parent")?.firstPrompt).toBe(
        "Active v2 request",
      );
      expect(sessions.find((s) => s.sessionId === "legacy-only")?.firstPrompt).toBe(
        "Legacy legacy-only",
      );
      expect(parseSessionFromDb(db, "ses_parent").turns[0].blocks[0]).toEqual({
        type: "text",
        text: "Active v2 request",
      });
      expect(parseSessionFromDb(db, "legacy-only").turns[0].blocks[0]).toEqual({
        type: "text",
        text: "Legacy legacy-only",
      });
    } finally {
      db.close();
    }
  });

  it("keeps sequence chronology when clocks move backward while retaining valid time bounds", async () => {
    const db = await v2Db();
    try {
      add(db, "first", "user", 0, { text: "First in sequence", time: { created: 1800000009000 } });
      add(db, "second", "user", 1, {
        text: "Second in sequence",
        time: { created: 1800000001000 },
      });
      db.run("UPDATE session_message SET time_created = 1800000009000 WHERE id = 'first'");
      const sessions = listSessionsFromDb(db);
      expect(sessions[0].firstPrompt).toBe("First in sequence");
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.turns.map((turn) => turn.blocks[0])).toEqual([
        { type: "text", text: "First in sequence" },
        { type: "text", text: "Second in sequence" },
      ]);
      expect(parsed.startTime).toBe("2027-01-15T08:00:01.000Z");
      expect(parsed.endTime).toBe("2027-01-15T08:00:09.000Z");
    } finally {
      db.close();
    }
  });

  it.each([
    ["exited", 0, false, true],
    ["exited", 1, true, true],
    ["timeout", undefined, true, true],
    ["killed", undefined, true, true],
    ["running", undefined, false, false],
  ])(
    "normalizes paged shell output and %s/exit=%s status",
    async (status, exit, failed, hasResult) => {
      const db = await v2Db();
      try {
        add(db, "u", "user", 0, { text: "Run tests" });
        add(db, "shell", "shell", 1, {
          shellID: "sh-test",
          command: "pnpm test",
          status,
          exit,
          output: { output: "shell result", cursor: 12, size: 12, truncated: false },
        });
        const parsed = parseSessionFromDb(db, "ses_parent");
        const block = parsed.turns[1].blocks[0] as Extract<ContentBlock, { type: "tool_use" }>;
        expect(block).toMatchObject({
          type: "tool_use",
          id: "sh-test",
          name: "Bash",
          _hasResult: hasResult,
        });
        expect(block._result).toBe(hasResult ? "shell result" : undefined);
        expect(block._isError).toBe(failed ? true : undefined);
      } finally {
        db.close();
      }
    },
  );

  it("keeps legacy shell strings and distinct invocation IDs", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, { text: "Run" });
      add(db, "old-shell", "shell", 1, { callID: "legacy-call", command: "pwd", output: "/repo" });
      add(db, "new-shell", "shell", 2, {
        shellID: "sh-new",
        command: "pwd",
        status: "exited",
        exit: 0,
        output: { output: "/repo", cursor: 5, size: 5, truncated: false },
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.turns.slice(1).map((t) => t.blocks[0])).toMatchObject([
        { id: "legacy-call", _result: "/repo" },
        { id: "sh-new", _result: "/repo" },
      ]);
    } finally {
      db.close();
    }
  });

  it("counts completed compactions only and retains failure evidence and separate usage", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, { text: "Inspect" });
      add(db, "a", "assistant", 1, {
        model: { id: "model-v2" },
        content: [{ type: "text", text: "Inspecting" }],
        tokens: { input: 10, output: 20 },
      });
      add(db, "complete", "compaction", 2, {
        status: "completed",
        reason: "manual",
        model: { id: "model-v2" },
        summary: "Summary",
        tokens: { input: 5, output: 7 },
        cost: 0.1,
      });
      add(db, "failed", "compaction", 3, {
        status: "failed",
        reason: "auto",
        error: { type: "APIError", message: "SECRET COMPACTION ERROR" },
        tokens: { input: 2, output: 3 },
      });
      add(db, "running", "compaction", 4, {
        status: "running",
        reason: "auto",
        summary: "Pending",
      });
      expect(listSessionsFromDb(db)[0].compactionCount).toBe(1);
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.compactions).toHaveLength(1);
      expect(parsed.turns).toHaveLength(2);
      expect(parsed.diagnostics).toMatchObject([
        { kind: "compaction", outcome: "succeeded", trigger: "manual" },
        { kind: "compaction", outcome: "failed", errorType: "APIError" },
      ]);
      expect(JSON.stringify(parsed.diagnostics)).not.toContain("SECRET COMPACTION ERROR");
      expect(parsed.diagnosticNotes?.[0]).toContain("still running");
      expect(parsed.tokenUsage).toMatchObject({ inputTokens: 17, outputTokens: 30 });
      expect(parsed.apiErrors).toBeUndefined();
      expect(parsed.turnStats?.[0].tokenUsage).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    } finally {
      db.close();
    }
  });

  it("uses the latest assistant model when the session table has no model column", async () => {
    const db = await v2Db();
    try {
      db.run("ALTER TABLE session_v2 DROP COLUMN model");
      add(db, "u", "user", 0, { text: "Inspect" });
      add(db, "a1", "assistant", 1, {
        model: { id: "first-model" },
        content: [{ type: "text", text: "First response" }],
      });
      add(db, "a2", "assistant", 2, {
        model: { id: "last-model" },
        content: [{ type: "text", text: "Last response" }],
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.model).toBe("last-model");
      expect(parsed.turns.slice(1).map((t) => t.model)).toEqual(["first-model", "last-model"]);
    } finally {
      db.close();
    }
  });

  it("preserves release-schema user attachments and tool image files", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, {
        text: "Inspect these images",
        files: [
          { data: "YWJjZA==", mime: "image/png", source: { type: "inline" }, name: "inline.png" },
          {
            data: "",
            mime: "image/png",
            source: { type: "uri", uri: "https://example.com/image.png" },
          },
        ],
      });
      add(db, "a", "assistant", 1, {
        model: { id: "model-v2" },
        content: [
          {
            type: "tool",
            id: "image-call",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/image.png" },
              content: [
                { type: "text", text: "Read image" },
                { type: "file", uri: "data:image/png;base64,YWJjZA==", mime: "image/png" },
              ],
            },
          },
        ],
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.turns[0].blocks).toContainEqual({
        type: "_user_images",
        images: ["data:image/png;base64,YWJjZA==", "https://example.com/image.png"],
      });
      expect(parsed.turns[1].blocks[0]).toMatchObject({
        type: "tool_use",
        _result: "Read image",
        _images: ["data:image/png;base64,YWJjZA=="],
      });
    } finally {
      db.close();
    }
  });

  it("preserves repeated native v2 skill activations without turning their prompt text into scenes", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, { text: "Review" });
      add(db, "skill1", "skill", 1, { name: "review", text: "PRIVATE SKILL PROMPT" });
      add(db, "skill2", "skill", 2, { name: "review", text: "PRIVATE SKILL PROMPT" });
      add(db, "skill3", "skill", 3, { name: "debug", text: "PRIVATE DEBUG PROMPT" });
      add(db, "a", "assistant", 4, { content: [{ type: "text", text: "Done" }] });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.skillsUsed).toEqual(["review", "debug"]);
      expect(parsed.skillActivations).toEqual(["review", "review", "debug"]);
      expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE SKILL PROMPT");
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE DEBUG PROMPT");
    } finally {
      db.close();
    }
  });

  it("includes v2 reasoning in aggregate and per-turn output totals", async () => {
    const db = await v2Db();
    try {
      add(db, "u", "user", 0, { text: "Inspect" });
      add(db, "a", "assistant", 1, {
        model: { id: "model-v2" },
        content: [{ type: "text", text: "Done" }],
        tokens: { input: 10, output: 2, reasoning: 8, cache: { read: 3, write: 4 } },
      });
      const parsed = parseSessionFromDb(db, "ses_parent");
      expect(parsed.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      });
      expect(parsed.tokenUsageByModel?.["model-v2"]).toEqual(parsed.tokenUsage);
      expect(parsed.turnStats?.[0].tokenUsage?.outputTokens).toBe(10);
    } finally {
      db.close();
    }
  });
});
