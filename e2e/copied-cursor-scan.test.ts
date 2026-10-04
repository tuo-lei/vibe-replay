import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
function run(root: string, ref: string, option: string) {
  return exec(
    process.execPath,
    [cli, "sessions", "--session", ref, "--provider", "cursor", option, "--json"],
    {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, "AppData/Roaming"),
        LOCALAPPDATA: join(root, "AppData/Local"),
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      },
    },
  );
}

it("scans the selected global-state copy rather than a same-ID native conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-copied-global-scan-"));
  try {
    const source = join(root, "copy.snapshot"),
      bytes = await globalStateDbBytes();
    await writeFile(source, bytes);
    const SQL = await testSqlite(),
      db = new SQL.Database(bytes),
      folder = join(root, "Library/Application Support/Cursor/User/globalStorage");
    await mkdir(folder, { recursive: true });
    const native = join(folder, "state.vscdb");
    try {
      db.run("UPDATE cursorDiskKV SET value=? WHERE key=?", [
        JSON.stringify({ type: 1, text: "Wrong native follow-up" }),
        `bubbleId:${GLOBAL_STATE_IDS[0]}:answer`,
      ]);
      await writeFile(native, db.export());
    } finally {
      db.close();
    }
    const before = await readFile(native);
    for (const option of ["--scan", "--brief"]) {
      const { stdout } = await run(root, `${source}#composerData:${GLOBAL_STATE_IDS[0]}`, option),
        data = JSON.parse(stdout);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0]).toMatchObject({
        scanStatus: "ready",
        scan: { promptCount: 1, toolCallCount: 0 },
      });
      expect(data.sessions[0].firstPrompt).toBe("Fix readonly output 1");
      expect(stdout).not.toContain("Wrong native follow-up");
    }
    expect(await readFile(source)).toEqual(Buffer.from(bytes));
    expect(await readFile(native)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("scans SDK model and usage from the explicit database copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-copied-sdk-scan-"));
  try {
    const source = join(root, "copy.snapshot"),
      id = "agent-scan-copy",
      SQL = await testSqlite(),
      db = new SQL.Database();
    let bytes: Uint8Array, nativeBytes: Uint8Array;
    try {
      db.run(
        "CREATE TABLE agents (agent_id TEXT PRIMARY KEY,workspace_ref TEXT,name TEXT,created_at TEXT,updated_at TEXT,status TEXT); CREATE TABLE runs (run_id TEXT,agent_id TEXT,turn_number INTEGER,status TEXT,model TEXT,started_at TEXT,finished_at TEXT,result TEXT,created_at TEXT,usage_json TEXT); CREATE TABLE run_events (run_id TEXT,seq INTEGER,event_type TEXT,payload_json TEXT,created_at TEXT);",
      );
      db.run(
        "INSERT INTO agents VALUES (?, '/repo', 'Copied scan', '2026-10-04','2026-10-04','COMPLETED')",
        [id],
      );
      db.run(
        "INSERT INTO runs VALUES ('run',?,1,'COMPLETED','copied-model','2026-10-04T00:00:00Z','2026-10-04T00:01:00Z','Complete','2026-10-04',?)",
        [id, JSON.stringify({ inputTokens: 21, outputTokens: 7 })],
      );
      bytes = db.export();
      await writeFile(source, bytes);
      db.run("UPDATE runs SET model='wrong-native-model',usage_json=?", [
        JSON.stringify({ inputTokens: 999, outputTokens: 888 }),
      ]);
      nativeBytes = db.export();
    } finally {
      db.close();
    }
    const folder = join(root, ".cursor/projects/native/sdk-agent-store/hash"),
      native = join(folder, "index.db");
    await mkdir(folder, { recursive: true });
    await writeFile(native, nativeBytes);
    await writeFile(
      join(root, `${id}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Scan the copied SDK task" }] },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Copied SDK response" }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    for (const option of ["--scan", "--brief"]) {
      const { stdout } = await run(root, `${source}#session:${id}`, option),
        data = JSON.parse(stdout);
      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0]).toMatchObject({
        scanStatus: "ready",
        scan: { promptCount: 1, tokenUsage: { inputTokens: 21, outputTokens: 7 } },
      });
      expect(data.sessions[0].scan.tokenUsageByModel).toHaveProperty("copied-model");
      expect(stdout).not.toContain("wrong-native-model");
    }
    expect(await readFile(source)).toEqual(Buffer.from(bytes));
    expect(await readFile(native)).toEqual(Buffer.from(nativeBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
