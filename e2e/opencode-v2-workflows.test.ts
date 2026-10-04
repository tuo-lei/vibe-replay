import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpencodeDb } from "../packages/provider-opencode/test/helpers/db.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let root: string;
function run(args: string[]) {
  return exec(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      OPENCODE_DATA: root,
      VIBE_REPLAY_CONFIG: join(root, "missing.json"),
      VIBE_REPLAY_DISABLE_FILE_CACHE: "1",
    },
  });
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vibe-cli-v2-"));
  const db = await buildOpencodeDb({ session: [], messages: [] });
  try {
    db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('ses_terminal', NULL, 'terminal', 'Run build', '/repo', '2.0.22', 1800000000000, 1800000010000);`);
    const messages = [
      ["user", { text: "Run the build" }],
      [
        "shell",
        {
          shellID: "sh-failed",
          command: "pnpm build",
          status: "exited",
          exit: 1,
          output: { output: "shell result: build failed", cursor: 26, size: 26, truncated: false },
        },
      ],
      ["shell", { shellID: "sh-running", command: "pnpm test", status: "running" }],
      ["compaction", { status: "completed", reason: "manual", summary: "Complete" }],
      [
        "compaction",
        {
          status: "failed",
          reason: "auto",
          error: { type: "APIError", message: "PRIVATE FAILURE TEXT" },
        },
      ],
      ["compaction", { status: "running", reason: "auto", summary: "Pending" }],
    ] as const;
    messages.forEach(([type, data], index) => {
      const timestamp = 1800000000000 + index * 1000;
      db.run("INSERT INTO session_message VALUES (?, 'ses_terminal', ?, ?, ?, ?)", [
        `msg-${index}`,
        type,
        index,
        timestamp,
        JSON.stringify({ time: { created: timestamp }, ...data }),
      ]);
    });
    await writeFile(join(root, "opencode.db"), db.export());
  } finally {
    db.close();
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("OpenCode v2 replay workflows", () => {
  it("transforms object shell output into searchable replay text without crashing", async () => {
    const { stdout } = await run([
      "inspect",
      "ses_terminal",
      "--provider",
      "opencode",
      "--query",
      "shell result",
      "--json",
    ]);
    expect(JSON.parse(stdout).scenes).toMatchObject([
      { type: "tool-call", toolName: "Bash", result: "shell result: build failed", isError: true },
    ]);
  });
  it("diagnoses terminal failure and completed/failed/running compactions independently", async () => {
    const { stdout } = await run(["diagnose", "ses_terminal", "--provider", "opencode", "--json"]);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      apiErrorCount: 0,
      toolErrorCount: 1,
      compactionCount: 1,
      diagnostics: [{ outcome: "succeeded" }, { outcome: "failed", errorType: "APIError" }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE FAILURE TEXT");
  });
});
