import { describe, expect, it } from "vitest";
import { listSessionsFromDb } from "../src/hermes/discover.js";
import { resolveSessionId } from "../src/hermes/parser.js";
import { buildHermesDb, toolCallsFor } from "./helpers/db.js";

describe("hermes discover", () => {
  it("lists sessions with stats and marker filePaths", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260804_202053_7b0f72",
          title: "Add Hermes support",
          cwd: "/Users/test/project",
          model: "deepseek-v4-flash-free",
          startedAt: 1_800_000_000,
          lastActivityAt: 1_800_000_050,
          messageCount: 10,
          toolCallCount: 4,
        },
        {
          id: "20260803_100000_abc123",
          title: null,
          cwd: "/Users/test/other",
          startedAt: 1_700_000_000,
          lastActivityAt: 1_700_000_100,
          messageCount: 3,
          toolCallCount: 1,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260804_202053_7b0f72",
          role: "user",
          content: "Add Hermes support to vibe-replay",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: "20260804_202053_7b0f72",
          role: "assistant",
          toolCalls: toolCallsFor([{ id: "c1", name: "patch", args: { path: "a.ts" } }]),
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: "20260804_202053_7b0f72",
          role: "user",
          content: "second prompt",
          timestamp: 1_800_000_003,
        },
        {
          id: 4,
          sessionId: "20260803_100000_abc123",
          role: "user",
          content: "",
          timestamp: 1_700_000_001,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);

      // Only the session with a non-empty first prompt is listed.
      expect(sessions).toHaveLength(1);
      const s = sessions[0];
      expect(s.provider).toBe("hermes");
      expect(s.sessionId).toBe("20260804_202053_7b0f72");
      expect(s.slug).toBe("20260804_202053_7b0f72");
      expect(s.title).toBe("Add Hermes support");
      expect(s.project).toBe("/Users/test/project");
      expect(s.cwd).toBe("/Users/test/project");
      expect(s.model).toBe("deepseek-v4-flash-free");
      expect(s.promptCount).toBe(2);
      expect(s.toolCallCount).toBe(4);
      expect(s.editCountEst).toBe(1);
      expect(s.firstPrompt).toBe("Add Hermes support to vibe-replay");
      expect(s.timestamp).toBe("2027-01-15T08:00:50.000Z");
      expect(s.durationMsEst).toBe(50_000);
      expect(s.hasSqlite).toBe(true);
      expect(s.filePath).toContain("#session:20260804_202053_7b0f72");
      expect(s.isStarred).toBe(false);
    } finally {
      db.close();
    }
  });

  it("maps pinned sessions to isStarred", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260801_120000_pin123",
          cwd: "/Users/test/pinned",
          startedAt: 1_600_000_000,
          pinned: 1,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260801_120000_pin123",
          role: "user",
          content: "pinned session prompt",
          timestamp: 1_600_000_001,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].isStarred).toBe(true);
    } finally {
      db.close();
    }
  });

  it("resolves session ids from markers and raw ids", () => {
    expect(resolveSessionId(["~/.hermes/state.db#session:20260804_202053_7b0f72"])).toBe(
      "20260804_202053_7b0f72",
    );
    expect(resolveSessionId(["20260804_202053_7b0f72"])).toBe("20260804_202053_7b0f72");
    expect(resolveSessionId(["/some/other/path.jsonl"])).toBeUndefined();
  });
});
