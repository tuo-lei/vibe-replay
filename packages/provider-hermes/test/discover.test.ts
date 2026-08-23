import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverHermesSessions, listSessionsFromDb } from "../src/hermes/discover.js";
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

describe("hermes multi-profile discovery", () => {
  it("merges sessions from the default DB and profile DBs with correct marker paths", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vibe-replay-hermes-")));
    const prevHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
    try {
      mkdirSync(join(home, "profiles", "codex"), { recursive: true });

      // Default DB: one legacy session.
      const defaultDb = await buildHermesDb({
        sessions: [
          {
            id: "20260801_090000_default",
            cwd: "/Users/test/legacy",
            startedAt: 1_700_000_000,
            lastActivityAt: 1_700_000_100,
          },
        ],
        messages: [
          {
            id: 1,
            sessionId: "20260801_090000_default",
            role: "user",
            content: "legacy default session",
            timestamp: 1_700_000_001,
          },
        ],
      });
      writeFileSync(join(home, "state.db"), defaultDb.export());
      defaultDb.close();

      // Profile DB: one newer session.
      const profileDb = await buildHermesDb({
        sessions: [
          {
            id: "20260822_222249_profile",
            cwd: "/Users/test/codex",
            startedAt: 1_800_000_000,
            lastActivityAt: 1_800_000_200,
          },
        ],
        messages: [
          {
            id: 1,
            sessionId: "20260822_222249_profile",
            role: "user",
            content: "active profile session",
            timestamp: 1_800_000_001,
          },
        ],
      });
      writeFileSync(join(home, "profiles", "codex", "state.db"), profileDb.export());
      profileDb.close();

      const sessions = await discoverHermesSessions();
      expect(sessions).toHaveLength(2);

      const byId = new Map(sessions.map((s) => [s.sessionId, s]));
      expect(byId.get("20260822_222249_profile")?.filePath).toBe(
        `${join(home, "profiles", "codex", "state.db")}#session:20260822_222249_profile`,
      );
      expect(byId.get("20260801_090000_default")?.filePath).toBe(
        `${join(home, "state.db")}#session:20260801_090000_default`,
      );

      // Newest activity first across profiles.
      expect(sessions[0].sessionId).toBe("20260822_222249_profile");
    } finally {
      if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = prevHermesHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("deduplicates a session id present in more than one database", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vibe-replay-hermes-")));
    const prevHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
    try {
      mkdirSync(join(home, "profiles", "copy"), { recursive: true });

      for (const dir of [home, join(home, "profiles", "copy")]) {
        const db = await buildHermesDb({
          sessions: [
            {
              id: "20260803_100000_dupe",
              cwd: "/Users/test/project",
              startedAt: 1_750_000_000,
              lastActivityAt: 1_750_000_100,
            },
          ],
          messages: [
            {
              id: 1,
              sessionId: "20260803_100000_dupe",
              role: "user",
              content: "duplicated session",
              timestamp: 1_750_000_001,
            },
          ],
        });
        writeFileSync(join(dir, "state.db"), db.export());
        db.close();
      }

      const sessions = await discoverHermesSessions();
      expect(sessions).toHaveLength(1);
      // The default DB is scanned first and wins the dedup.
      expect(sessions[0].filePath.startsWith(`${join(home, "state.db")}#session:`)).toBe(true);
    } finally {
      if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = prevHermesHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
