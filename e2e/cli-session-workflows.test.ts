import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpencodeDb } from "../packages/provider-opencode/test/helpers/db.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let root: string;
const replay = {
  meta: {
    sessionId: "saved-session",
    slug: "saved",
    title: "Build evidence",
    provider: "codex",
    stats: { sceneCount: 3, userPrompts: 1, toolCalls: 1, thinkingBlocks: 0 },
  },
  scenes: [
    { type: "user-prompt", content: "Why did the build fail?" },
    {
      type: "tool-call",
      toolName: "Bash",
      input: { command: "get-logs" },
      result: "npm error code EUSAGE: lockfile mismatch",
      isError: false,
    },
    { type: "text-response", content: "Installation failed before tests" },
  ],
};
function run(args: string[]) {
  return exec(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      OPENCODE_DATA: root,
      VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
      VIBE_REPLAY_DISABLE_FILE_CACHE: "1",
      VIBE_REPLAY_NO_AUTO_OPEN: "1",
    },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vibe-cli-workflows-"));
  await writeFile(join(root, "replay.json"), JSON.stringify(replay));
  const db = await buildOpencodeDb({
    session: [
      { id: "ses_workflow1", title: "First task" },
      { id: "ses_workflow2", title: "Second task" },
    ],
    messages: [
      {
        id: "u1",
        sessionId: "ses_workflow1",
        role: "user",
        parts: [{ type: "text", text: "Fix build" }],
      },
      {
        id: "u2",
        sessionId: "ses_workflow2",
        role: "user",
        parts: [{ type: "text", text: "Review tests" }],
      },
    ],
  });
  try {
    await writeFile(join(root, "opencode.db"), db.export());
  } finally {
    db.close();
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CLI session workflows", () => {
  it("infers a raw OpenCode database path and reports contained-session ambiguity", async () => {
    await expect(run(["inspect", join(root, "opencode.db"), "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Ambiguous"),
    });
  });

  it("selects only the requested session and exposes discovery coverage", async () => {
    const { stdout } = await run([
      "sessions",
      "--provider",
      "opencode",
      "--session",
      "ses_workflow1",
      "--json",
    ]);
    const data = JSON.parse(stdout);
    expect(data.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["ses_workflow1"]);
    expect(data.discovery.coverage).toEqual([
      { provider: "opencode", status: "ready", sessionCount: 2 },
    ]);
    expect(data.discovery.partial).toBe(false);
  });

  it("rejects ambiguous references and root-only options instead of silently ignoring them", async () => {
    await expect(
      run(["sessions", "--provider", "opencode", "--session", "ses_workflow", "--json"]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Ambiguous") });
    await expect(run(["sessions", "--github", "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--github is not supported by sessions"),
    });
  });

  it("exports a source by ID without a viewer build and emits clean Markdown stdout", async () => {
    const { stdout } = await run([
      "export",
      "ses_workflow1",
      "--provider",
      "opencode",
      "--format",
      "markdown",
      "--stdout",
    ]);
    expect(stdout).toMatch(/^### AI Coding Session: First task\n/);
    expect(stdout).toContain("Fix build");
    expect(stdout).not.toContain("session-preview");
    expect(stdout).not.toMatch(/vibe-replay v\d/);
  });

  it("searches result content and distinguishes evidence from a failed tool invocation", async () => {
    const { stdout } = await run([
      "diagnose",
      join(root, "replay.json"),
      "--query",
      "EUSAGE",
      "--json",
    ]);
    const data = JSON.parse(stdout);
    expect(data.apiErrorCount).toBe(0);
    expect(data.toolErrorCount).toBe(0);
    expect(data.evidence.scenes[0]).toMatchObject({
      index: 1,
      result: "npm error code EUSAGE: lockfile mismatch",
    });
  });

  it("preflights sharing without writes or uploads and marks the no-auth fallback", async () => {
    const before = await readdir(root);
    const raw = await readFile(join(root, "replay.json"), "utf-8");
    const { stdout } = await run([
      "share",
      root,
      "--api-url",
      "http://127.0.0.1:65431",
      "--dry-run",
      "--json",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      mode: "local-fallback",
      uploaded: false,
      visibility: "unlisted",
      withinCloudLimit: true,
    });
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(join(root, "replay.json"), "utf-8")).toBe(raw);
  });

  it("returns a structured error for an invalid scene and bounds content slices", async () => {
    await expect(run(["inspect", root, "--scene", "100", "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('"error":"Scene index must be below 3"'),
    });
    const { stdout } = await run(["inspect", root, "--offset", "1", "--limit", "1", "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({
      matchCount: 2,
      truncated: true,
      scenes: [{ index: 1 }],
    });
  });

  it("rejects blank searches and mismatched scopes on replay paths", async () => {
    await expect(run(["inspect", root, "--query", " ", "--json"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--query cannot be empty"),
    });
    await expect(
      run(["share", root, "--dry-run", "--provider", "pi", "--json"]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Replay provider") });
    await expect(run(["export", root, "--target", "remote", "--stdout"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Replay belongs to target"),
    });
  });
});
