import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let hasSqlite = false;
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  hasSqlite = true;
} catch {
  /* portable hosts use WASM */
}

it.skipIf(!hasSqlite)(
  "stdout export and share preflight preserve copied WAL sources without creating shm",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-readonly-wal-"));
    const original = join(root, "writer.db"),
      source = join(root, "copy.snapshot");
    const writer = spawn("sqlite3", [original], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let text = "";
        writer.stdout.on("data", (chunk) => {
          text += String(chunk);
          if (text.includes("WAL-READY")) resolve();
        });
        writer.on("error", reject);
      });
      writer.stdin.write(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY,value TEXT);\nPRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nINSERT INTO cursorDiskKV VALUES ('composerData:11111111-1111-4111-8111-111111111111', '{}');\n.print WAL-READY\n",
      );
      await ready;
      await copyFile(original, source);
      await copyFile(`${original}-wal`, `${source}-wal`);
      const beforeNames = (await readdir(root)).sort(),
        beforeDb = await readFile(source),
        beforeWal = await readFile(`${source}-wal`);
      expect(beforeNames).not.toContain("copy.snapshot-shm");
      for (const args of [
        ["export", source, "--stdout"],
        ["share", source, "--dry-run", "--json"],
        ["export", source, "--provider", "cursor", "--stdout"],
        ["share", source, "--provider", "cursor", "--dry-run", "--json"],
      ]) {
        await expect(
          exec(process.execPath, [cli, ...args], {
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              APPDATA: join(root, "AppData/Roaming"),
              LOCALAPPDATA: join(root, "AppData/Local"),
              VIBE_REPLAY_CONFIG: join(root, "missing.json"),
              VIBE_REPLAY_TELEMETRY: "0",
            },
          }),
        ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Checkpoint") });
      }
      expect((await readdir(root)).sort()).toEqual(beforeNames);
      expect(await readFile(source)).toEqual(beforeDb);
      expect(await readFile(`${source}-wal`)).toEqual(beforeWal);
    } finally {
      writer.stdin.end(".quit\n");
      if (writer.exitCode === null) await once(writer, "exit");
      await rm(root, { recursive: true, force: true });
    }
  },
);
