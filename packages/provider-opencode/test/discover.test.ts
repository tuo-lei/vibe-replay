import { describe, expect, it } from "vitest";
import { listSessionsFromDb } from "../src/opencode/discover.js";
import { buildOpencodeDb } from "./helpers/db.js";

describe("opencode discover", () => {
  it("lists non-subagent sessions with discovery stats", async () => {
    const db = await buildOpencodeDb({
      session: [
        {
          id: "ses_main",
          slug: "swift-eagle",
          title: "Add opencode support",
          directory: "/Users/test/project",
          model: JSON.stringify({ id: "deepseek-v4-flash-free", providerID: "opencode" }),
          timeCreated: 1_800_000_000_000,
          timeUpdated: 1_800_000_100_000,
        },
        {
          id: "ses_sub",
          slug: "sub-agent",
          directory: "/Users/test/project",
          parentId: "ses_main",
          timeCreated: 1_800_000_000_000,
          timeUpdated: 1_800_000_050_000,
        },
      ],
      messages: [
        {
          id: "m1",
          sessionId: "ses_main",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [{ type: "text", text: "Please add opencode support" }],
        },
        {
          id: "m2",
          sessionId: "ses_main",
          role: "assistant",
          timeCreated: 1_800_000_020_000,
          finish: "tool-calls",
          parts: [
            { type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } },
            { type: "tool", tool: "edit", callID: "c2", state: { status: "completed" } },
          ],
        },
        {
          id: "m3",
          sessionId: "ses_main",
          role: "user",
          timeCreated: 1_800_000_030_000,
          parts: [{ type: "text", text: "Now the second prompt" }],
        },
        {
          id: "m4",
          sessionId: "ses_sub",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [{ type: "text", text: "Help with sub-agent work" }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);

      // The sub-agent session has parent_id set, so it is excluded from
      // discovery even though it has a directory and would otherwise qualify.
      expect(sessions).toHaveLength(1);
      expect(sessions.some((s) => s.sessionId === "ses_sub")).toBe(false);

      const main = sessions.find((s) => s.sessionId === "ses_main");
      expect(main).toBeDefined();
      expect(main).toMatchObject({
        provider: "opencode",
        slug: "swift-eagle",
        title: "Add opencode support",
        project: "/Users/test/project",
        cwd: "/Users/test/project",
        model: "deepseek-v4-flash-free",
        firstPrompt: "Please add opencode support",
        promptCount: 2,
        toolCallCount: 2,
        editCountEst: 1,
        hasSqlite: true,
      });
      expect(main?.filePath).toContain("#session:ses_main");
      expect(main?.durationMsEst).toBe(20_000);
    } finally {
      db.close();
    }
  });

  it("skips sessions without a user text prompt", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_empty", slug: "empty", directory: "/Users/test/project" }],
      messages: [
        {
          id: "me1",
          sessionId: "ses_empty",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [{ type: "file", url: "x.png", mime: "image/png" }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("concatenates text parts and skips malformed first parts", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_parts", slug: "parts", directory: "/Users/test/project" }],
      messages: [
        {
          id: "m_parts",
          sessionId: "ses_parts",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [],
        },
      ],
    });

    // Simulate a malformed JSON part followed by a valid part in the first
    // user message. The discovery query reads raw SQLite data, so this cannot
    // be represented by JSON.stringify in the normal seed helper.
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)", [
      "prt_malformed",
      "m_parts",
      "ses_parts",
      1_800_000_010_000,
      "{not-json",
    ]);
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)", [
      "prt_valid_1",
      "m_parts",
      "ses_parts",
      1_800_000_010_000,
      JSON.stringify({ type: "text", text: "First part" }),
    ]);
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)", [
      "prt_valid_2",
      "m_parts",
      "ses_parts",
      1_800_000_010_000,
      JSON.stringify({ type: "text", text: "second part" }),
    ]);

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].firstPrompt).toBe("First part second part");
    } finally {
      db.close();
    }
  });

  it("indexes context compactions during discovery", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_compacted", slug: "compacted", directory: "/Users/test/project" }],
      messages: [
        {
          id: "mc1",
          sessionId: "ses_compacted",
          role: "user",
          parts: [{ type: "text", text: "Start a long task" }],
        },
        {
          id: "mc2",
          sessionId: "ses_compacted",
          role: "user",
          parts: [{ type: "compaction", auto: true }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].compactionCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("excludes synthetic compaction text from prompt discovery", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_compaction_text", slug: "compaction-text" }],
      messages: [
        {
          id: "mct1",
          sessionId: "ses_compaction_text",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [
            { type: "compaction", auto: true },
            { type: "text", text: "Synthetic context summary" },
          ],
        },
        {
          id: "mct2",
          sessionId: "ses_compaction_text",
          role: "user",
          timeCreated: 1_800_000_020_000,
          parts: [{ type: "text", text: "Continue the real task" }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        firstPrompt: "Continue the real task",
        promptCount: 1,
        compactionCount: 1,
      });
    } finally {
      db.close();
    }
  });
});
