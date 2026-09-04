import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shortenPath } from "@vibe-replay/provider-core/utils";
import { discoverHermesSessions, listSessionsFromDb } from "../src/hermes/discover.js";
import { resolveSessionId } from "../src/hermes/parser.js";
import { hermesProfileDir } from "../src/hermes/sqlite.js";
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

  it("does not count context-compaction markers as prompts", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260806_090000_cmpct1",
          cwd: "/Users/test/project",
          startedAt: 1_800_000_000,
          lastActivityAt: 1_800_000_010,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260806_090000_cmpct1",
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: "20260806_090000_cmpct1",
          role: "user",
          content: "real prompt after compaction",
          timestamp: 1_800_000_002,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].promptCount).toBe(1);
      expect(sessions[0].firstPrompt).toBe("real prompt after compaction");
    } finally {
      db.close();
    }
  });

  it("indexes each context-compaction boundary during discovery", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260806_090000_cmpct2",
          cwd: "/Users/test/project",
          startedAt: 1_800_000_000,
          lastActivityAt: 1_800_000_010,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260806_090000_cmpct2",
          role: "user",
          content: "first prompt",
          compacted: 1,
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: "20260806_090000_cmpct2",
          role: "assistant",
          content: "first answer",
          compacted: 1,
          timestamp: 1_800_000_002,
        },
        {
          id: 3,
          sessionId: "20260806_090000_cmpct2",
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] First summary.",
          timestamp: 1_800_000_003,
        },
        {
          id: 4,
          sessionId: "20260806_090000_cmpct2",
          role: "user",
          content: "second prompt",
          compacted: 1,
          timestamp: 1_800_000_004,
        },
        {
          id: 5,
          sessionId: "20260806_090000_cmpct2",
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] Second summary.",
          timestamp: 1_800_000_005,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].compactionCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("indexes summary markers from Hermes stores without a compacted column", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260806_090000_legacy",
          cwd: "/Users/test/project",
          startedAt: 1_800_000_000,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260806_090000_legacy",
          role: "user",
          content: "first prompt",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: "20260806_090000_legacy",
          role: "user",
          content: "[CONTEXT COMPACTION — REFERENCE ONLY] Legacy summary.",
          timestamp: 1_800_000_002,
        },
      ],
    });
    db.run("ALTER TABLE messages DROP COLUMN compacted");

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].compactionCount).toBe(1);
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

  it("maps Bot Chat sessions without cwd to their profile path so bots are distinct", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260901_222657_bot123",
          title: "Bot Chat",
          cwd: "",
          profileName: "ru",
          startedAt: 1_800_000_000,
          lastActivityAt: 1_800_000_010,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260901_222657_bot123",
          role: "user",
          content: "hello bot",
          timestamp: 1_800_000_001,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db, "/tmp/.hermes/profiles/ru/state.db");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].project).toBe(shortenPath(hermesProfileDir("ru")!));
      expect(sessions[0].cwd).toBe("");
    } finally {
      db.close();
    }
  });

  it("maps cwd-less Bot Chat sessions under a custom HERMES_HOME", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vibe-replay-hermes-")));
    const prevHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260901_222657_custom",
          title: "Bot Chat",
          cwd: null,
          profileName: "ru",
          startedAt: 1_800_000_000,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260901_222657_custom",
          role: "user",
          content: "hello bot",
          timestamp: 1_800_000_001,
        },
      ],
    });
    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].project).toBe(shortenPath(hermesProfileDir("ru")!));
    } finally {
      db.close();
      if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = prevHermesHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats whitespace-only cwd as missing and ignores path-like profile names", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260901_222657_blankcwd",
          cwd: "   ",
          profileName: "codex",
          startedAt: 1_800_000_000,
        },
        {
          id: "20260901_222657_badprof",
          cwd: "",
          profileName: "../etc",
          startedAt: 1_800_000_000,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260901_222657_blankcwd",
          role: "user",
          content: "whitespace cwd bot",
          timestamp: 1_800_000_001,
        },
        {
          id: 2,
          sessionId: "20260901_222657_badprof",
          role: "user",
          content: "unsafe profile name",
          timestamp: 1_800_000_002,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      const byId = new Map(sessions.map((s) => [s.sessionId, s]));
      expect(byId.get("20260901_222657_blankcwd")?.project).toBe(
        shortenPath(hermesProfileDir("codex")!),
      );
      expect(byId.get("20260901_222657_badprof")?.project).toBe("Hermes");
    } finally {
      db.close();
    }
  });

  it("falls back to generic Hermes project when neither cwd nor profile is set", async () => {
    const db = await buildHermesDb({
      sessions: [
        {
          id: "20260901_222657_noprof",
          cwd: null,
          profileName: null,
          startedAt: 1_800_000_000,
        },
      ],
      messages: [
        {
          id: 1,
          sessionId: "20260901_222657_noprof",
          role: "user",
          content: "hello",
          timestamp: 1_800_000_001,
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].project).toBe("Hermes");
    } finally {
      db.close();
    }
  });
});
