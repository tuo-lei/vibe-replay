import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildHermesDb } from "../packages/provider-hermes/test/helpers/db.js";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let hasSqlite = false;
try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  hasSqlite = true;
} catch {
  /* native WAL fixture requires sqlite3 */
}

it.skipIf(!hasSqlite)("retains healthy Hermes profiles beside an active WAL profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-hermes-partial-wal-"));
  const profile = join(root, "profiles/bot"),
    healthy = join(root, "state.db"),
    active = join(profile, "state.db");
  let writer: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(profile, { recursive: true });
    for (const [path, id, title] of [
      [healthy, "session_healthy", "Healthy checkpointed profile"],
      [active, "session_active", "Active bot profile"],
    ]) {
      const db = await buildHermesDb({
        sessions: [{ id, title, cwd: root }],
        messages: [{ id: 1, sessionId: id, role: "user", content: `Task for ${id}` }],
      });
      try {
        await writeFile(path, db.export());
      } finally {
        db.close();
      }
    }
    writer = spawn("sqlite3", [active], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = new Promise<void>((resolve, reject) => {
      let text = "";
      writer!.stdout!.on("data", (chunk) => {
        text += String(chunk);
        if (text.includes("WAL-READY")) resolve();
      });
      writer!.on("error", reject);
    });
    writer.stdin!.write(
      "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nUPDATE sessions SET title='Pending WAL title' WHERE id='session_active';\n.print WAL-READY\n",
    );
    await ready;
    const paths = [healthy, active, `${active}-wal`, `${active}-shm`];
    const before = await Promise.all(paths.map((path) => readFile(path))),
      rootNames = (await readdir(root)).sort(),
      profileNames = (await readdir(profile)).sort();
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      HERMES_HOME: root,
      VIBE_REPLAY_CONFIG: join(root, "missing.json"),
      VIBE_REPLAY_TELEMETRY: "0",
    };
    const run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
    const exported = await run([
      "export",
      "session_healthy",
      "--provider",
      "hermes",
      "--stdout",
      "--refresh",
    ]);
    expect(exported.stdout).toContain("Task for session\\_healthy");
    expect(exported.stdout).toContain("Healthy checkpointed profile");
    const shared = await run([
      "share",
      "session_healthy",
      "--provider",
      "hermes",
      "--dry-run",
      "--json",
      "--refresh",
    ]);
    expect(JSON.parse(shared.stdout)).toMatchObject({
      uploaded: false,
      sessionId: "session_healthy",
    });
    await expect(
      run(["export", "session_active", "--provider", "hermes", "--stdout", "--refresh"]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Checkpoint") });
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    expect((await readdir(root)).sort()).toEqual(rootNames);
    expect((await readdir(profile)).sort()).toEqual(profileNames);
  } finally {
    if (writer) {
      writer.stdin!.end(".quit\n");
      if (writer.exitCode === null) await once(writer, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});
