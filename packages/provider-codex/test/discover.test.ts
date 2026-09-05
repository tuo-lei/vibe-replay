import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_REMOTE_METADATA_SCRIPT, parseCodexRemoteMetadata } from "../src/codex/remote.js";
import {
  discoverCodexSessions,
  extractCodexSessionInfo,
  mergeCodexSessionMetadata,
  readCodexSessionIndex,
  type CodexSessionMetadata,
} from "../src/codex/discover.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

const SQLITE3_TEST_PATH = "/usr/bin:/bin";
const HAS_SQLITE3_CLI =
  process.platform !== "win32" &&
  spawnSync("sqlite3", ["--version"], {
    stdio: "ignore",
    env: { ...process.env, PATH: SQLITE3_TEST_PATH },
  }).status === 0;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "codex",
    sessionId: "codex-session",
    slug: "codex-se",
    project: "~/old-project",
    cwd: "/home/user/old-project",
    version: "old-version",
    timestamp: "2026-08-24T10:00:00.000Z",
    lineCount: 10,
    fileSize: 100,
    filePath: "/tmp/rollout.jsonl",
    filePaths: ["/tmp/rollout.jsonl"],
    firstPrompt: "Inspect the old project",
    prompts: ["Inspect the old project", "Make the change"],
    model: "old-model",
    gitBranch: "old-branch",
    ...overrides,
  };
}

describe("mergeCodexSessionMetadata", () => {
  it("uses state metadata for the resume title while preserving replay fields", () => {
    const metadata: CodexSessionMetadata = {
      sessionId: "codex-session",
      title: "Implement the new feature",
      cwd: `${homedir()}/new-project`,
      cliVersion: "new-version",
      gitBranch: "feature/new",
      model: "new-model",
      updatedAtMs: 1_756_031_700_000,
      firstUserMessage: "Implement the new feature",
    };

    expect(mergeCodexSessionMetadata(session(), metadata)).toMatchObject({
      title: "Implement the new feature",
      project: "~/new-project",
      cwd: `${homedir()}/new-project`,
      version: "new-version",
      gitBranch: "feature/new",
      model: "new-model",
      timestamp: "2025-08-24T10:35:00.000Z",
      firstPrompt: "Implement the new feature",
      filePath: "/tmp/rollout.jsonl",
      filePaths: ["/tmp/rollout.jsonl"],
    });
  });

  it("does not merge metadata for another session", () => {
    const result = mergeCodexSessionMetadata(session(), {
      sessionId: "different-session",
      title: "Should not be used",
    });
    expect(result).toEqual(session());
  });

  it("keeps JSONL values when state metadata is incomplete", () => {
    const result = mergeCodexSessionMetadata(session(), {
      sessionId: "codex-session",
    });
    expect(result).toEqual(session());
  });

  it("prefers the latest explicit thread name over the state database title", () => {
    expect(
      mergeCodexSessionMetadata(session(), {
        sessionId: "codex-session",
        title: "Generated state title",
        threadName: "Renamed thread",
      }).title,
    ).toBe("Renamed thread");
  });

  it("does not turn state metadata into a fake prompt for a no-prompt transcript", () => {
    const result = mergeCodexSessionMetadata(
      session({ transcriptStatus: "no-prompts", firstPrompt: "", prompts: undefined }),
      {
        sessionId: "codex-session",
        title: "Metadata-only thread",
        firstUserMessage: "This must not become replay content",
      },
    );

    expect(result).toMatchObject({
      title: "Metadata-only thread",
      transcriptStatus: "no-prompts",
      firstPrompt: "",
    });
    expect(result.prompts).toBeUndefined();
  });
});

describe("Codex session rename index", () => {
  it("uses the latest valid append for each thread id", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-codex-index-"));
    try {
      await writeFile(
        join(root, "session_index.jsonl"),
        [
          JSON.stringify({
            id: "codex-session",
            thread_name: "Old name",
            updated_at: "2026-08-24T10:00:00Z",
          }),
          "{incomplete",
          JSON.stringify({
            id: "codex-session",
            thread_name: "Latest name",
            updated_at: "2026-08-24T11:00:00Z",
          }),
        ].join("\n"),
      );

      expect(await readCodexSessionIndex(root)).toEqual(
        new Map([["codex-session", "Latest name"]]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies an explicit thread name without requiring the SQLite state database", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-codex-index-discovery-"));
    try {
      const sessionsDir = join(root, "sessions", "2026", "08", "24");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "rollout-codex-session.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-08-24T10:00:00.000Z",
            payload: { id: "codex-session", cwd: "/tmp/project" },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-08-24T10:00:01.000Z",
            payload: { type: "user_message", message: "Original prompt text" },
          }),
        ].join("\n"),
      );
      await writeFile(
        join(root, "session_index.jsonl"),
        `${JSON.stringify({
          id: "codex-session",
          thread_name: "Renamed thread",
          updated_at: "2026-08-24T11:00:00Z",
        })}\n`,
      );

      expect(await discoverCodexSessions(root, false, false)).toMatchObject([
        { sessionId: "codex-session", title: "Renamed thread" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extractCodexSessionInfo transcript status", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  async function writeRollout(content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "vibe-replay-codex-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "rollout-2026-08-24-codexsession.jsonl");
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("keeps a readable metadata-only rollout with an explicit no-prompts status", async () => {
    const filePath = await writeRollout(
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            id: "codex-session",
            cwd: "/tmp/project",
            cli_version: "1.0.0",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-08-24T10:00:01.000Z",
          payload: { model: "gpt-test" },
        }),
      ].join("\n"),
    );

    const result = await extractCodexSessionInfo(filePath, 1);

    expect(result).toMatchObject({
      sessionId: "codex-session",
      project: "/tmp/project",
      title: undefined,
      firstPrompt: "",
      promptCount: 0,
      transcriptStatus: "no-prompts",
    });
    expect(result?.prompts).toBeUndefined();
  });

  it("treats world_state envelope records as known Codex metadata", async () => {
    const secret = "WORLD_STATE_INSTRUCTION_BLOB";
    const filePath = await writeRollout(
      [
        JSON.stringify({
          type: "session_meta",
          ordinal: 0,
          timestamp: "2026-09-04T15:32:40.000Z",
          payload: { id: "codex-session", cwd: "/tmp/project" },
        }),
        JSON.stringify({
          type: "world_state",
          ordinal: 1,
          timestamp: "2026-09-04T15:32:40.100Z",
          payload: {
            full: true,
            state: {
              model: "gpt-5.6-sol",
              skills: { body: secret },
            },
          },
        }),
      ].join("\n"),
    );

    const result = await extractCodexSessionInfo(filePath, 2);

    expect(result).toMatchObject({
      sessionId: "codex-session",
      model: "gpt-5.6-sol",
      firstPrompt: "",
      promptCount: 0,
      transcriptStatus: "no-prompts",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps short human prompts replayable", async () => {
    const filePath = await writeRollout(
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: { id: "codex-session", cwd: "/tmp/project" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-24T10:00:01.000Z",
          payload: { type: "user_message", message: "fix it" },
        }),
      ].join("\n"),
    );

    expect(await extractCodexSessionInfo(filePath, 1)).toMatchObject({
      firstPrompt: "fix it",
      promptCount: 1,
      transcriptStatus: undefined,
    });
  });

  it("marks an unreadable rollout instead of silently dropping it", async () => {
    const filePath = await writeRollout("{not valid json}\n");

    const result = await extractCodexSessionInfo(filePath, 17);

    expect(result).toMatchObject({
      sessionId: "codexsession",
      firstPrompt: "",
      transcriptStatus: "unreadable",
    });
    expect(result?.promptCount).toBe(0);
  });
});

describe("Codex state metadata discovery", () => {
  it("keeps a state-only thread visible when its rollout is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-codex-state-"));
    const codexHome = join(root, "codex");
    const sqliteHome = join(root, "sqlite");
    const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
    try {
      await mkdir(join(codexHome, "sessions"), { recursive: true });
      await mkdir(sqliteHome, { recursive: true });
      const mod = await import("sql.js");
      const SQL = await mod.default();
      const db = new SQL.Database();
      db.run(`
        CREATE TABLE threads (
          id TEXT NOT NULL,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          cwd TEXT,
          title TEXT,
          tokens_used INTEGER,
          git_branch TEXT,
          cli_version TEXT,
          first_user_message TEXT,
          model TEXT,
          reasoning_effort TEXT,
          created_at_ms INTEGER,
          updated_at_ms INTEGER,
          archived INTEGER DEFAULT 0
        );
      `);
      db.run(`
        INSERT INTO threads (
          id, created_at, updated_at, source, cwd, title, model, archived
        ) VALUES (
          'state-only', 1756031400, 1756031700, 'cli',
          '/remote/project', 'State-only title', 'gpt-test', 0
        );
      `);
      await writeFile(join(sqliteHome, "state_5.sqlite"), Buffer.from(db.export()));
      db.close();
      process.env.CODEX_SQLITE_HOME = sqliteHome;

      const result = await import("../src/codex/discover.js").then((module) =>
        module.discoverCodexSessions(codexHome, true, false),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        sessionId: "state-only",
        slug: "state-on",
        title: "State-only title",
        project: "/remote/project",
        cwd: "/remote/project",
        model: "gpt-test",
        firstPrompt: "",
        promptCount: 0,
        transcriptStatus: "unreadable",
        filePaths: [],
      });
    } finally {
      if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the requested Codex home and replaces an unavailable state row with its rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-codex-rollout-"));
    const codexHome = join(root, "codex");
    const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
    try {
      delete process.env.CODEX_SQLITE_HOME;
      const sessionsDir = join(codexHome, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const rolloutPath = join(sessionsDir, "session-codex-rollout.jsonl");
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-08-24T10:00:00.000Z",
            payload: {
              id: "codex-rollout",
              cwd: "/remote/project",
            },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-08-24T10:00:01.000Z",
            payload: {
              type: "message",
              role: "user",
              content: "Please inspect this test project",
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const { default: SQL } = await import("sql.js");
      const sql = await SQL();
      const database = new sql.Database();
      database.run(`
        CREATE TABLE threads (
          id TEXT NOT NULL,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          cwd TEXT,
          title TEXT,
          tokens_used INTEGER,
          git_branch TEXT,
          cli_version TEXT,
          first_user_message TEXT,
          model TEXT,
          archived INTEGER DEFAULT 0
        );
        INSERT INTO threads (
          id, created_at, updated_at, cwd, title, first_user_message, archived
        ) VALUES (
          'codex-rollout', 1756031400, 1756031700, '/remote/project',
          'Resume title', 'Please inspect this test project', 0
        );
      `);
      await writeFile(join(codexHome, "state_5.sqlite"), Buffer.from(database.export()));
      database.close();

      const result = await discoverCodexSessions(codexHome, true, false);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        sessionId: "codex-rollout",
        title: "Resume title",
        firstPrompt: "Please inspect this test project",
        transcriptStatus: undefined,
        filePath: rolloutPath,
        filePaths: [rolloutPath],
      });
    } finally {
      if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Codex remote metadata script", () => {
  it.skipIf(!HAS_SQLITE3_CLI)(
    "falls back to a schema-aware sqlite3 CLI query when Python is unavailable",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "vibe-replay-codex-remote-"));
      try {
        const fakeBin = join(root, "bin");
        await mkdir(fakeBin, { recursive: true });
        await writeFile(join(fakeBin, "python3"), "#!/bin/sh\nexit 127\n", "utf-8");
        await chmod(join(fakeBin, "python3"), 0o755);
        const { default: SQL } = await import("sql.js");
        const db = await SQL();
        const database = new db.Database();
        database.run(`
        CREATE TABLE threads (
          id TEXT NOT NULL,
          title TEXT,
          updated_at TEXT
        );
        INSERT INTO threads (id, title, updated_at)
        VALUES ('cli-fallback', 'CLI fallback title', '2026-08-24T10:00:00.000Z');
      `);
        await writeFile(join(root, "state_5.sqlite"), Buffer.from(database.export()));
        database.close();

        const output = await runShellScript(CODEX_REMOTE_METADATA_SCRIPT, {
          HOME: root,
          CODEX_HOME: root,
          CODEX_SQLITE_HOME: "",
          PATH: `${fakeBin}:${SQLITE3_TEST_PATH}`,
        });
        expect(output.code).toBe(0);
        const parsed = parseCodexRemoteMetadata(Buffer.from(output.stdout));
        expect(parsed.available).toBe(true);
        expect(parsed.entries.get("cli-fallback")).toMatchObject({
          sessionId: "cli-fallback",
          title: "CLI fallback title",
          updatedAt: "2026-08-24T10:00:00.000Z",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function runShellScript(
  script: string,
  environment: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-s"], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf-8") }));
    child.stdin.end(script);
  });
}
