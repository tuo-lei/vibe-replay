import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discoverCodexSessions } from "../src/codex/discover.js";

it.each([false, true])(
  "preserves compactions with the SQLite index enabled=%s",
  async (indexed) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-compaction-parity-"));
    const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
    const previousCache = process.env.VIBE_REPLAY_DISABLE_FILE_CACHE;
    delete process.env.CODEX_SQLITE_HOME;
    process.env.VIBE_REPLAY_DISABLE_FILE_CACHE = "1";
    try {
      await mkdir(join(root, "sessions"));
      const path = join(root, "sessions", "rollout.jsonl");
      await writeFile(
        path,
        [
          { type: "session_meta", payload: { id: "compaction-session", cwd: "/example/project" } },
          {
            type: "response_item",
            payload: { type: "message", role: "user", content: "Investigate the build" },
          },
          {
            type: "event_msg",
            timestamp: "2026-11-03T01:00:00Z",
            payload: { type: "context_compacted" },
          },
          { type: "compacted", timestamp: "2026-11-03T02:00:00Z", payload: { message: "Summary" } },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );
      if (indexed) {
        const { default: initSql } = await import("sql.js");
        const sql = await initSql();
        const db = new sql.Database();
        db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, archived INTEGER)");
        db.run("INSERT INTO threads VALUES (?, ?, ?, 0)", [
          "compaction-session",
          path,
          "Indexed title",
        ]);
        await writeFile(join(root, "state_5.sqlite"), Buffer.from(db.export()));
        db.close();
      }
      const sessions = await discoverCodexSessions(root, indexed, false);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "compaction-session",
        compactionCount: 2,
        promptCount: 1,
      });
    } finally {
      if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
      if (previousCache === undefined) delete process.env.VIBE_REPLAY_DISABLE_FILE_CACHE;
      else process.env.VIBE_REPLAY_DISABLE_FILE_CACHE = previousCache;
      await rm(root, { recursive: true, force: true });
    }
  },
);
