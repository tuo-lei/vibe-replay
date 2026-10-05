import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
function run(root: string, args: string[]) {
  return exec(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "AppData/Roaming"),
      LOCALAPPDATA: join(root, "AppData/Local"),
      VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
      VIBE_REPLAY_TELEMETRY: "0",
    },
  });
}

it("reads a copied Cursor global-state database instead of the configured store with identical IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-copied-cursor-"));
  try {
    const source = join(root, "copy.snapshot");
    const bytes = await globalStateDbBytes();
    await writeFile(source, bytes);
    const SQL = await testSqlite();
    const native = new SQL.Database(bytes);
    const nativeFolder = join(root, "Library/Application Support/Cursor/User/globalStorage");
    await mkdir(nativeFolder, { recursive: true });
    try {
      native.run(
        "UPDATE cursorDiskKV SET value = replace(value, 'Fix readonly output', 'Wrong machine content')",
      );
      await writeFile(join(nativeFolder, "state.vscdb"), native.export());
    } finally {
      native.close();
    }
    await expect(run(root, ["inspect", source, "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Ambiguous"),
    });
    const nativeBytes = await readFile(join(nativeFolder, "state.vscdb"));
    const marker = `${source}#composerData:${GLOBAL_STATE_IDS[0]}`;
    const { stdout } = await run(root, [
      "inspect",
      marker,
      "--query",
      "Fix readonly output",
      "--json",
    ]);
    expect(JSON.parse(stdout).scenes).toMatchObject([
      { type: "user-prompt", text: "Fix readonly output 1" },
    ]);
    expect((await run(root, ["export", marker, "--stdout"])).stdout).toContain(
      "Fix readonly output 1",
    );
    expect(
      JSON.parse((await run(root, ["share", marker, "--dry-run", "--json"])).stdout),
    ).toMatchObject({ sessionId: GLOBAL_STATE_IDS[0], uploaded: false });
    const listed = JSON.parse(
      (await run(root, ["sessions", "--session", marker, "--provider", "cursor", "--json"])).stdout,
    );
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].firstPrompt).toBe("Fix readonly output 1");
    expect(await readFile(source)).toEqual(Buffer.from(bytes));
    const single = new SQL.Database(bytes);
    try {
      single.run("DELETE FROM cursorDiskKV WHERE key LIKE ?", [`%${GLOBAL_STATE_IDS[1]}%`]);
      await writeFile(source, single.export());
    } finally {
      single.close();
    }
    expect(JSON.parse((await run(root, ["inspect", source, "--json"])).stdout).sessionId).toBe(
      GLOBAL_STATE_IDS[0],
    );
    expect(await readFile(join(nativeFolder, "state.vscdb"))).toEqual(nativeBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a copied SDK index and companion transcript, with an explicit missing-transcript status", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-copied-sdk-"));
  try {
    const source = join(root, "copy.snapshot"),
      agent = "agent-copy-first",
      companion = join(root, `${agent}.jsonl`);
    const SQL = await testSqlite(),
      db = new SQL.Database();
    db.run(`CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT, name TEXT, created_at TEXT, updated_at TEXT, status TEXT);
      CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, status TEXT, model TEXT, started_at TEXT, finished_at TEXT, result TEXT, created_at TEXT);
      CREATE TABLE run_events (run_id TEXT, seq INTEGER, event_type TEXT, payload_json TEXT, created_at TEXT);`);
    for (const id of [agent, "agent-copy-second"])
      db.run(
        "INSERT INTO agents VALUES (?, '/repo', 'Copied SDK task', '2026-10-04', '2026-10-04', 'COMPLETED')",
        [id],
      );
    db.run(
      "INSERT INTO runs VALUES ('run-one', ?, 1, 'COMPLETED', 'copied-sdk-model', '2026-10-04T00:00:00Z', '2026-10-04T00:01:00Z', 'Complete', '2026-10-04T00:00:00Z')",
      [agent],
    );
    const bytes = db.export();
    await writeFile(source, bytes);
    const nativeFolder = join(root, ".cursor/projects/native/sdk-agent-store/hash");
    await mkdir(nativeFolder, { recursive: true });
    try {
      db.run("UPDATE runs SET model = 'wrong-machine-model'");
      await writeFile(join(nativeFolder, "index.db"), db.export());
    } finally {
      db.close();
    }
    const nativeBytes = await readFile(join(nativeFolder, "index.db"));
    await writeFile(
      companion,
      [
        { role: "user", message: { content: [{ type: "text", text: "Copied SDK prompt" }] } },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Copied SDK response" }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    await expect(
      run(root, ["inspect", source, "--provider", "cursor", "--json"]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Ambiguous") });
    const marker = `${source}#session:${agent}`;
    const inspected = JSON.parse((await run(root, ["inspect", marker, "--json"])).stdout);
    expect(inspected).toMatchObject({ sessionId: agent, stats: { userPrompts: 1 } });
    const exported = JSON.parse(
      (await run(root, ["export", marker, "--format", "json", "--stdout"])).stdout,
    );
    expect(exported.meta.model).toBe("copied-sdk-model");
    expect(JSON.stringify(exported)).not.toContain("wrong-machine-model");
    const listed = JSON.parse(
      (await run(root, ["sessions", "--session", marker, "--provider", "cursor", "--json"])).stdout,
    );
    expect(listed.sessions[0].firstPrompt).toBe("Copied SDK prompt");
    expect(
      JSON.parse((await run(root, ["share", marker, "--dry-run", "--json"])).stdout).uploaded,
    ).toBe(false);
    await unlink(companion);
    const missing = JSON.parse(
      (await run(root, ["sessions", "--session", marker, "--provider", "cursor", "--json"])).stdout,
    );
    expect(missing.sessions[0].transcriptStatus).toBe("no-prompts");
    await expect(run(root, ["inspect", marker, "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("companion transcript"),
    });
    expect(await readFile(source)).toEqual(Buffer.from(bytes));
    expect(await readFile(join(nativeFolder, "index.db"))).toEqual(nativeBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
