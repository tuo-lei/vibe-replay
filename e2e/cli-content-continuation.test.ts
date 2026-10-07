import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
let root: string, env: NodeJS.ProcessEnv, source: string, saved: string, revision: string;
const id = "abcd1234-continuation";
const log = `${"diagnostic line\n".repeat(400)}EUSAGE at the end`;
function run(args: string[]) {
  return exec(process.execPath, [cli, ...args], { env });
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vibe-cli-continuation-"));
  const sessions = join(root, ".codex", "sessions", "2026", "10", "06");
  await mkdir(sessions, { recursive: true });
  source = join(sessions, "rollout-continuation.jsonl");
  env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: join(root, ".codex"),
    CODEX_SQLITE_HOME: join(root, ".codex"),
    VIBE_REPLAY_CONFIG: join(root, "missing.json"),
    VIBE_REPLAY_DISABLE_FILE_CACHE: "1",
    VIBE_REPLAY_TELEMETRY: "0",
    VIBE_REPLAY_NO_AUTO_OPEN: "1",
  };
  await writeFile(
    source,
    [
      { type: "session_meta", payload: { id, cwd: root }, timestamp: "2026-10-06T00:00:00Z" },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Find EUSAGE" }],
        },
      },
      ...["First EUSAGE", log, "Last EUSAGE"].map((text) => ({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const fresh = JSON.parse((await run(["export", source, "--format", "json", "--stdout"])).stdout);
  saved = join(root, ".vibe-replay", fresh.meta.slug);
  await mkdir(saved, { recursive: true });
  fresh.scenes = [
    { type: "user-prompt", content: "Older saved request" },
    { type: "text-response", content: "Old EUSAGE evidence" },
  ];
  fresh.meta.stats.sceneCount = fresh.scenes.length;
  await writeFile(join(saved, "replay.json"), JSON.stringify(fresh));
  await writeFile(
    join(saved, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [{ sceneIndex: 0, modifiedValue: "Saved edited request", updatedAt: "2026-10-06" }],
    }),
  );
  revision = JSON.parse(
    (await run(["inspect", id, "--provider", "codex", "--source", "--json"])).stdout,
  ).revision;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it("selects source or saved effective content consistently across inspection, diagnosis, export, and preflight", async () => {
  for (const command of ["inspect", "diagnose", "export", "share"]) {
    const extra =
      command === "export"
        ? ["--format", "json", "--output", join(root, "out")]
        : command === "share"
          ? ["--dry-run"]
          : [];
    const current = JSON.parse(
      (
        await run([
          command,
          id,
          "--provider",
          "codex",
          "--source",
          "--revision",
          revision,
          "--json",
          ...extra,
        ])
      ).stdout,
    );
    const snapshot = JSON.parse(
      (await run([command, id, "--provider", "codex", "--snapshot", "--json", ...extra])).stdout,
    );
    expect(current.provenance).toMatchObject({ origin: "source", revision, sceneCount: 4 });
    expect(snapshot.provenance).toMatchObject({ origin: "snapshot", sceneCount: 2 });
    expect(snapshot.provenance.revision).not.toBe(revision);
    await expect(
      run([
        command,
        id,
        "--provider",
        "codex",
        "--snapshot",
        "--revision",
        revision,
        "--json",
        ...extra,
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("revision mismatch") });
  }
  const exported = JSON.parse(
    (await run(["export", id, "--provider", "codex", "--snapshot", "--format", "json", "--stdout"]))
      .stdout,
  );
  expect(exported.scenes[0].content).toBe("Saved edited request");
  expect(exported.provenance).toBeUndefined();
  const before = await readFile(join(saved, "replay.json"));
  await expect(run(["inspect", id, "--source", "--snapshot", "--json"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Use only one"),
  });
  expect(await readFile(join(saved, "replay.json"))).toEqual(before);
});

it("follows search continuation and reads the entire long response with bounded character pages", async () => {
  const first = JSON.parse(
    (await run(["inspect", source, "--query", "EUSAGE", "--limit", "2", "--json"])).stdout,
  );
  const next = JSON.parse(
    (
      await run([
        "inspect",
        source,
        "--query",
        "EUSAGE",
        "--offset",
        String(first.nextOffset),
        "--revision",
        first.revision,
        "--json",
      ])
    ).stdout,
  );
  expect(first.scenes.map((s: any) => s.index)).toEqual([0, 1]);
  expect(next.scenes.map((s: any) => s.index)).toEqual([2, 3]);
  expect(next.truncated).toBe(false);
  const human = (await run(["inspect", source, "--query", "EUSAGE", "--limit", "1"])).stdout;
  expect(human).toContain("keep --query and use --offset 1 --revision");
  let offset = 0,
    recovered = "";
  for (;;) {
    const page = JSON.parse(
      (
        await run([
          "inspect",
          source,
          "--scene",
          "2",
          "--text-offset",
          String(offset),
          "--text-limit",
          "2000",
          "--revision",
          revision,
          "--json",
        ])
      ).stdout,
    ).scenes[0].content;
    recovered += page.value;
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  expect(recovered).toBe(log);
  await expect(run(["inspect", source, "--text-offset", "1", "--json"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("require --scene"),
  });
});

it("handles renamed JSON through inspect, export, and share preflight with no writes or unrelated edits", async () => {
  const path = join(saved, "incident.json");
  await writeFile(path, (await run(["export", source, "--format", "json", "--stdout"])).stdout);
  const before = await readdir(saved);
  const inspected = JSON.parse((await run(["inspect", path, "--json"])).stdout);
  const shared = JSON.parse((await run(["share", path, "--dry-run", "--json"])).stdout);
  expect(inspected.provenance).toMatchObject({ origin: "snapshot", revision, sceneCount: 4 });
  expect(shared.provenance).toEqual(inspected.provenance);
  const text = (await run(["export", path, "--stdout"])).stdout;
  expect(text).toContain("Find EUSAGE");
  expect(text).not.toContain("Saved edited request");
  expect(await readdir(saved)).toEqual(before);
});

it.each([
  ["live", "--session", "abcd1234"],
  ["live", id],
  ["--session", id, "live"],
])("starts the live server for explicit references: %j", async (...args: string[]) => {
  const child = spawn(process.execPath, [cli, ...args, "--provider", "codex"], { env });
  let output = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Live server timeout: ${output}`)), 15000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Live exited ${code}: ${output}`));
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /http:\/\/localhost:\d+\/\?live=1[^\s]+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    expect(new URL(url).searchParams.get("sessionId")).toBe(id);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<html");
  } finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
});
