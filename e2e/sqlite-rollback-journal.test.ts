import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  GLOBAL_STATE_IDS,
  globalStateDbBytes,
} from "../packages/provider-cursor/test/helpers/global-state-db.js";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let hasSqlite = false;
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  hasSqlite = true;
} catch {
  /* portable unit tests cover both snapshot readers */
}

it.skipIf(!hasSqlite)(
  "rejects spilled rollback transactions and accepts committed PERSIST journals",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-live-journal-")),
      source = join(root, "source.db");
    await writeFile(source, await globalStateDbBytes());
    const writer = spawn("sqlite3", [source], { stdio: ["pipe", "pipe", "pipe"] }),
      runWriter = (commands: string, marker: string) =>
        new Promise<void>((resolve, reject) => {
          let output = "";
          const data = (chunk: Buffer) => {
            output += String(chunk);
            if (output.includes(marker)) {
              writer.stdout.off("data", data);
              resolve();
            }
          };
          writer.stdout.on("data", data);
          writer.once("error", reject);
          writer.stdin.write(commands);
        });
    try {
      await runWriter(
        `PRAGMA journal_mode=PERSIST;\nPRAGMA cache_size=1;\nCREATE TABLE filler (data BLOB);\nINSERT INTO filler VALUES (randomblob(50000));\nBEGIN IMMEDIATE;\nUPDATE cursorDiskKV SET value=json_set(value,'$.text','Transaction task') WHERE key='bubbleId:${GLOBAL_STATE_IDS[0]}:user';\nINSERT INTO filler VALUES (randomblob(500000));\n.print JOURNAL-READY\n`,
        "JOURNAL-READY",
      );
      const journal = `${source}-journal`,
        paths = [source, journal],
        before = await Promise.all(paths.map((path) => readFile(path))),
        names = (await readdir(root)).sort(),
        marker = `${source}#composerData:${GLOBAL_STATE_IDS[0]}`,
        env = {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          APPDATA: join(root, "AppData/Roaming"),
          LOCALAPPDATA: join(root, "AppData/Local"),
          VIBE_REPLAY_CONFIG: join(root, "missing.json"),
          VIBE_REPLAY_TELEMETRY: "0",
        };
      expect(before[1].length).toBeGreaterThan(512);
      expect(before[1].subarray(0, 28)).not.toEqual(Buffer.alloc(28));
      for (const args of [
        ["export", marker, "--format", "json", "--stdout"],
        ["share", marker, "--dry-run", "--json"],
        ["export", marker, "--provider", "cursor", "--format", "json", "--stdout"],
        ["share", marker, "--provider", "cursor", "--dry-run", "--json"],
      ])
        await expect(exec(process.execPath, [cli, ...args], { env })).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("rollback journal"),
        });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      expect((await readdir(root)).sort()).toEqual(names);
      await runWriter("COMMIT;\n.print COMMIT-DONE\n", "COMMIT-DONE");
      const committed = await Promise.all(paths.map((path) => readFile(path)));
      expect(committed[1].length).toBeGreaterThan(512);
      expect(committed[1].subarray(0, 28)).toEqual(Buffer.alloc(28));
      const replay = JSON.parse(
        (
          await exec(process.execPath, [cli, "export", marker, "--format", "json", "--stdout"], {
            env,
          })
        ).stdout,
      );
      expect(replay.meta.provider).toBe("cursor");
      expect(replay.scenes).toContainEqual(
        expect.objectContaining({ type: "user-prompt", content: "Transaction task" }),
      );
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(committed);
    } finally {
      writer.stdin.end(".quit\n");
      if (writer.exitCode === null) await once(writer, "exit");
      await rm(root, { recursive: true, force: true });
    }
  },
);
