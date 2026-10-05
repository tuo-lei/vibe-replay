import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { testSqlite } from "../packages/provider-cursor/test/helpers/global-state-db.js";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let hasSqlite = false;
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  hasSqlite = true;
} catch {
  /* native WAL fixture requires sqlite3 */
}

it.skipIf(!hasSqlite)(
  "retains healthy SDK enrichment when an unrelated index requires checkpointing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-sdk-partial-wal-"));
    const id = "agent-sdk-healthy",
      project = join(root, ".cursor/projects/project");
    const folder = join(project, "sdk-agent-store/0-busy"),
      source = join(folder, "index.db"),
      transcriptFolder = join(project, "agent-transcripts", id),
      transcript = join(transcriptFolder, `${id}.jsonl`);
    const healthyFolder = join(project, "sdk-agent-store/1-healthy"),
      healthy = join(healthyFolder, "index.db");
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(folder, { recursive: true });
      await mkdir(healthyFolder, { recursive: true });
      await mkdir(transcriptFolder, { recursive: true });
      const SQL = await testSqlite(),
        db = new SQL.Database();
      try {
        db.run(
          "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT, name TEXT, created_at TEXT, updated_at TEXT, status TEXT); CREATE TABLE runs (run_id TEXT,agent_id TEXT,turn_number INTEGER,status TEXT,model TEXT,started_at TEXT,finished_at TEXT,result TEXT,created_at TEXT,usage_json TEXT); CREATE TABLE run_events (run_id TEXT,seq INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT);",
        );
        db.run(
          "INSERT INTO agents VALUES (?, ?, 'SDK task', '2026-10-04', '2026-10-04', 'COMPLETED')",
          ["agent-sdk-busy", root],
        );
        await writeFile(source, db.export());
        db.run("UPDATE agents SET agent_id = ?", [id]);
        db.run(
          "INSERT INTO runs VALUES ('run',?,1,'COMPLETED','healthy-sdk-model','2026-10-04T00:00:00Z','2026-10-04T00:01:00Z','Complete','2026-10-04',?)",
          [id, JSON.stringify({ inputTokens: 21, outputTokens: 7 })],
        );
        for (const [seq, status] of ["running", "completed"].entries()) {
          db.run("INSERT INTO run_events VALUES ('run',?,'run_stream_event',?,?)", [
            seq,
            JSON.stringify({
              schemaVersion: 1,
              type: "sdk_message",
              message: {
                type: "tool_call",
                call_id: "sdk-shell",
                name: "shell",
                status,
                args: { command: "echo SDK evidence" },
                ...(status === "completed"
                  ? {
                      result: {
                        status: "success",
                        value: { exitCode: 0, stdout: "SDK-only evidence", stderr: "" },
                      },
                    }
                  : {}),
              },
            }),
            `2026-10-04T00:00:0${seq + 1}Z`,
          ]);
        }
        await writeFile(healthy, db.export());
      } finally {
        db.close();
      }
      await writeFile(
        transcript,
        [
          {
            role: "user",
            message: { content: [{ type: "text", text: "Investigate healthy SDK results" }] },
          },
          {
            role: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "sdk-shell",
                  name: "shell",
                  input: { command: "echo SDK evidence" },
                },
              ],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      writer = spawn("sqlite3", [source], { stdio: ["pipe", "pipe", "pipe"] });
      const ready = new Promise<void>((resolve, reject) => {
        let text = "";
        writer!.stdout!.on("data", (chunk) => {
          text += String(chunk);
          if (text.includes("WAL-READY")) resolve();
        });
        writer!.on("error", reject);
      });
      writer.stdin!.write(
        "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nUPDATE agents SET name='Pending SDK data';\n.print WAL-READY\n",
      );
      await ready;
      const paths = [source, `${source}-wal`, `${source}-shm`, transcript, healthy],
        before = await Promise.all(paths.map((path) => readFile(path))),
        names = (await readdir(folder)).sort(),
        healthyNames = (await readdir(healthyFolder)).sort();
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      };
      for (const reference of [id, transcript]) {
        const data = JSON.parse(
          (
            await exec(
              process.execPath,
              [
                cli,
                "export",
                reference,
                "--provider",
                "cursor",
                "--format",
                "json",
                "--stdout",
                "--refresh",
              ],
              { env },
            )
          ).stdout,
        );
        expect(data.meta.model).toBe("healthy-sdk-model");
        expect(data.meta.stats.tokenUsage).toMatchObject({ inputTokens: 21, outputTokens: 7 });
        expect(JSON.stringify(data)).toContain("SDK-only evidence");
      }
      const shared = JSON.parse(
        (
          await exec(
            process.execPath,
            [cli, "share", id, "--provider", "cursor", "--dry-run", "--json", "--refresh"],
            { env },
          )
        ).stdout,
      );
      expect(shared).toMatchObject({ sessionId: id, uploaded: false });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      expect((await readdir(folder)).sort()).toEqual(names);
      expect((await readdir(healthyFolder)).sort()).toEqual(healthyNames);
    } finally {
      if (writer) {
        writer.stdin!.end(".quit\n");
        if (writer.exitCode === null) await once(writer, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
