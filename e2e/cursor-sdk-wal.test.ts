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
  "propagates SDK checkpoints through cold discovery and transcript enrichment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-sdk-wal-"));
    const id = "agent-sdk-wal",
      project = join(root, ".cursor/projects/project");
    const folder = join(project, "sdk-agent-store/hash"),
      source = join(folder, "index.db"),
      transcriptFolder = join(project, "agent-transcripts", id),
      transcript = join(transcriptFolder, `${id}.jsonl`);
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(folder, { recursive: true });
      await mkdir(transcriptFolder, { recursive: true });
      const SQL = await testSqlite(),
        db = new SQL.Database();
      try {
        db.run(
          "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT, name TEXT, created_at TEXT, updated_at TEXT, status TEXT); CREATE TABLE runs (run_id TEXT,agent_id TEXT); CREATE TABLE run_events (run_id TEXT,seq INTEGER,payload_json TEXT);",
        );
        db.run(
          "INSERT INTO agents VALUES (?, ?, 'SDK task', '2026-10-04', '2026-10-04', 'COMPLETED')",
          [id, root],
        );
        await writeFile(source, db.export());
      } finally {
        db.close();
      }
      await writeFile(
        transcript,
        `${JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "Investigate SDK results" }] },
        })  }\n`,
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
      const paths = [source, `${source}-wal`, `${source}-shm`, transcript],
        before = await Promise.all(paths.map((path) => readFile(path))),
        names = (await readdir(folder)).sort();
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      };
      for (const args of [
        ["export", id, "--provider", "cursor", "--stdout", "--refresh"],
        ["export", transcript, "--provider", "cursor", "--stdout", "--refresh"],
        ["share", id, "--provider", "cursor", "--dry-run", "--json", "--refresh"],
      ])
        await expect(exec(process.execPath, [cli, ...args], { env })).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("Checkpoint"),
        });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      expect((await readdir(folder)).sort()).toEqual(names);
    } finally {
      if (writer) {
        writer.stdin!.end(".quit\n");
        if (writer.exitCode === null) await once(writer, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
