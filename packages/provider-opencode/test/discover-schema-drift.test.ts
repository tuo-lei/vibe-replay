import initSqlJs, { type Database } from "sql.js";
import { describe, expect, it } from "vitest";
import { listSessionsFromDb } from "../src/opencode/discover.js";

// Regression coverage for upstream opencode schema drift.
//
// opencode dropped `agent`, `model`, `cost`, `tokens_input`, and `tokens_output`
// from its `session` table. Discovery selected those columns unconditionally, so
// it threw `no such column: s.agent`. That throw escaped `discoverAllSessions()`
// in the CLI, which had no per-provider isolation, so a drifted opencode DB took
// down session listing for *every* provider — Cursor and Claude Code included.
//
// This fixture is deliberately built inline rather than through
// `buildOpencodeDb`, which models the older, wider schema that other tests
// still assert against.

async function buildDriftedDb(): Promise<Database> {
  const sql = await initSqlJs();
  const db = new sql.Database();

  // The trimmed shape observed on opencode >= the columns removal.
  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      name TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `);

  db.run(
    "INSERT INTO session (id, project_id, slug, title, directory, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [
      "ses_drift",
      "prj_1",
      "tidy-tiger",
      "Session on a drifted schema",
      "/Users/test/project",
      "1.0.0",
      1_800_000_000_000,
      1_800_000_100_000,
    ],
  );
  db.run("INSERT INTO project (id, worktree, name) VALUES (?,?,?)", [
    "prj_1",
    "/Users/test/project",
    "project",
  ]);
  db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)", [
    "m1",
    "ses_drift",
    1_800_000_010_000,
    JSON.stringify({ role: "user", time: { created: 1_800_000_010_000 }, type: "message" }),
  ]);
  db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)", [
    "prt_1",
    "m1",
    "ses_drift",
    1_800_000_010_000,
    JSON.stringify({ type: "text", text: "Please add opencode support" }),
  ]);

  return db;
}

describe("opencode discover under schema drift", () => {
  it("lists sessions when optional session columns have been dropped upstream", async () => {
    const db = await buildDriftedDb();
    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("ses_drift");
      expect(sessions[0].slug).toBe("tidy-tiger");
      expect(sessions[0].title).toBe("Session on a drifted schema");
      expect(sessions[0].firstPrompt).toBe("Please add opencode support");
    } finally {
      db.close();
    }
  });

  it("degrades dropped optional columns to undefined instead of throwing", async () => {
    const db = await buildDriftedDb();
    try {
      const session = listSessionsFromDb(db)[0];
      // `model` lived in the dropped `session.model` column.
      expect(session.model).toBeUndefined();
      // `version` survived the drift and must still be projected.
      expect(session.version).toBe("1.0.0");
      expect(session.cwd).toBe("/Users/test/project");
    } finally {
      db.close();
    }
  });

  it("filters subagent rows only while the parent_id column exists", async () => {
    const db = await buildDriftedDb();
    try {
      db.run(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          "ses_child",
          "prj_1",
          "ses_drift",
          "child",
          "/Users/test/project",
          "Subagent session",
          "1.0.0",
          1_800_000_000_000,
          1_800_000_050_000,
        ],
      );
      const sessions = listSessionsFromDb(db);
      expect(sessions.map((s) => s.sessionId)).toEqual(["ses_drift"]);
    } finally {
      db.close();
    }
  });
});
