import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  GLOBAL_STATE_IDS,
  globalStateDbBytes,
  testSqlite,
} from "../packages/provider-cursor/test/helpers/global-state-db.js";

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
  "preserves healthy Cursor global-state IDs when another store requires checkpointing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-global-partial-wal-")),
      id = GLOBAL_STATE_IDS[0],
      busy = "33333333-3333-4333-8333-333333333333";
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      const globalFolder = join(
          root,
          process.platform === "win32" ? "AppData/Roaming" : "Library/Application Support",
          "Cursor/User/globalStorage",
        ),
        folder = join(root, ".cursor/chats/hash", busy),
        source = join(folder, "store.db"),
        globalDb = join(globalFolder, "state.vscdb");
      await mkdir(globalFolder, { recursive: true });
      await mkdir(folder, { recursive: true });
      await writeFile(globalDb, await globalStateDbBytes());
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
      const paths = [source, `${source}-wal`, `${source}-shm`, globalDb],
        before = await Promise.all(paths.map((path) => readFile(path))),
        names = (await readdir(folder)).sort(),
        globalNames = (await readdir(globalFolder)).sort();
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
      ).toContain("Fix readonly output 1");
      const shared = JSON.parse(
        (await run(["share", id, "--provider", "cursor", "--dry-run", "--json", "--refresh"]))
          .stdout,
      );
      expect(shared).toMatchObject({ sessionId: id, uploaded: false });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      expect((await readdir(folder)).sort()).toEqual(names);
      expect((await readdir(globalFolder)).sort()).toEqual(globalNames);
    } finally {
      if (writer) {
        writer.stdin!.end(".quit\n");
        if (writer.exitCode === null) await once(writer, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
