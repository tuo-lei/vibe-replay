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
  "preserves healthy Cursor JSONL IDs when another store requires checkpointing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-partial-wal-")),
      id = "11111111-1111-4111-8111-111111111111",
      busy = "22222222-2222-4222-8222-222222222222";
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      const transcripts = join(root, ".cursor/projects/project/agent-transcripts"),
        folder = join(root, ".cursor/chats/hash", busy),
        source = join(folder, "store.db");
      await mkdir(transcripts, { recursive: true });
      await mkdir(folder, { recursive: true });
      const transcript = join(transcripts, `${id}.jsonl`);
      await writeFile(
        transcript,
        [
          { role: "user", message: { content: [{ type: "text", text: "Healthy JSONL task" }] } },
          { role: "assistant", message: { content: [{ type: "text", text: "Healthy result" }] } },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      const SQL = await testSqlite(),
        db = new SQL.Database();
      try {
        db.run(
          "CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY,data BLOB);",
        );
        db.run("INSERT INTO meta VALUES ('0',?)", [
          Buffer.from(JSON.stringify({ name: "Busy unrelated store" })).toString("hex"),
        ]);
        await writeFile(source, db.export());
      } finally {
        db.close();
      }
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
        "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nUPDATE meta SET value='pending' WHERE key='0';\n.print WAL-READY\n",
      );
      await ready;
      const paths = [source, `${source}-wal`, `${source}-shm`, transcript],
        before = await Promise.all(paths.map((path) => readFile(path))),
        names = (await readdir(folder)).sort();
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, "AppData/Roaming"),
        LOCALAPPDATA: join(root, "AppData/Local"),
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      };
      const run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
      expect(
        (await run(["export", id, "--provider", "cursor", "--stdout", "--refresh"])).stdout,
      ).toContain("Healthy JSONL task");
      const shared = JSON.parse(
        (await run(["share", id, "--provider", "cursor", "--dry-run", "--json", "--refresh"]))
          .stdout,
      );
      expect(shared).toMatchObject({ sessionId: id, uploaded: false });
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
