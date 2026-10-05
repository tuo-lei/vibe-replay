import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildHermesDb } from "../packages/provider-hermes/test/helpers/db.js";
import { buildOpencodeDb } from "../packages/provider-opencode/test/helpers/db.js";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let hasSqlite = false;
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  hasSqlite = true;
} catch {
  /* native WAL fixture requires sqlite3 */
}

it.skipIf(!hasSqlite).each(["hermes", "opencode"])(
  "guards %s native IDs against ignored pending WAL, with cached or fresh discovery",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-wasm-native-wal-")),
      id = "session_native_wal";
    const source = join(root, provider === "hermes" ? "state.db" : "opencode.db");
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      const db =
        provider === "hermes"
          ? await buildHermesDb({
              sessions: [{ id, cwd: root }],
              messages: [
                { id: 1, sessionId: id, role: "user", content: "Investigate current evidence" },
              ],
            })
          : await buildOpencodeDb({
              session: [{ id }],
              messages: [
                {
                  id: "msg-user",
                  sessionId: id,
                  role: "user",
                  parts: [{ type: "text", text: "Investigate current evidence" }],
                },
              ],
            });
      try {
        await writeFile(source, db.export());
      } finally {
        db.close();
      }
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        HERMES_HOME: root,
        OPENCODE_DATA: root,
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      };
      const run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
      const listed = JSON.parse(
        (await run(["sessions", "--provider", provider, "--any", "--refresh", "--json"])).stdout,
      );
      expect(listed.sessions).toMatchObject([{ sessionId: id }]);
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
        `PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nUPDATE ${provider === "hermes" ? "sessions" : "session"} SET title = 'Pending WAL title' WHERE id = '${id}';\n.print WAL-READY\n`,
      );
      await ready;
      const names = [source, `${source}-wal`, `${source}-shm`];
      const before = await Promise.all(names.map((path) => readFile(path)));
      const beforeNames = (await readdir(root)).sort();
      for (const args of [
        ["export", id, "--provider", provider, "--stdout"],
        ["share", id, "--provider", provider, "--dry-run", "--json"],
        ["export", id, "--provider", provider, "--stdout", "--refresh"],
      ])
        await expect(run(args)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("Checkpoint"),
        });
      expect(await Promise.all(names.map((path) => readFile(path)))).toEqual(before);
      expect((await readdir(root)).sort()).toEqual(beforeNames);
    } finally {
      if (writer) {
        writer.stdin!.end(".quit\n");
        if (writer.exitCode === null) await once(writer, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
