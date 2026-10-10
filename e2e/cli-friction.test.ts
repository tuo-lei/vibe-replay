import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
const home = await mkdtemp(join(tmpdir(), "vibe-cli-friction-"));
const env = {
  ...process.env,
  HOME: home,
  VIBE_REPLAY_TELEMETRY: "0",
  VIBE_REPLAY_NO_AUTO_OPEN: "1",
};
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
async function run(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const err = error as Error & { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

it("validates interactively selected saved edits before logged-out or cloud sharing", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const isolatedHome = await mkdtemp(join(tmpdir(), "vibe-interactive-share-"));
  const dir = join(isolatedHome, ".vibe-replay", "picked");
  await mkdir(dir, { recursive: true });
  const raw = JSON.stringify({
    meta: {
      sessionId: "picked-session",
      slug: "picked",
      title: "Saved incident",
      provider: "codex",
    },
    scenes: [{ type: "user-prompt", content: "DO_NOT_SHARE_ORIGINAL_CANARY" }],
  });
  await writeFile(join(dir, "replay.json"), raw);
  try {
    for (const loggedIn of [false, true]) {
      if (loggedIn)
        await writeFile(
          join(isolatedHome, ".vibe-replay", "auth.json"),
          JSON.stringify({
            accounts: {
              [origin]: { token: "fixture-only", user: { id: "fixture", name: "Fixture" } },
            },
          }),
        );
      for (const sidecar of ["overlays.json", "annotations.json"]) {
        await writeFile(join(dir, sidecar), "{");
        const result = await new Promise<{ output: string; code: number | null }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, [cli, "share"], {
              env: { ...env, HOME: isolatedHome, VIBE_REPLAY_API_URL: origin },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let output = "";
            let selected = false;
            const timer = setTimeout(() => {
              child.kill();
              reject(new Error(`Interactive share timed out: ${output}`));
            }, 10_000);
            const data = (chunk: Buffer) => {
              output += chunk.toString();
              if (!selected && output.includes("Pick a replay to share")) {
                selected = true;
                child.stdin.write("\n");
              }
            };
            child.stdout.on("data", data);
            child.stderr.on("data", data);
            child.on("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ output, code });
            });
          },
        );
        expect(result.code).toBe(1);
        expect(result.output).toContain("Cannot safely read saved edits");
        expect(result.output).toContain(sidecar);
        expect(result.output).not.toContain("DO_NOT_SHARE_ORIGINAL_CANARY");
        expect(await readFile(join(dir, "replay.json"), "utf-8")).toBe(raw);
        expect(await readFile(join(dir, sidecar), "utf-8")).toBe("{");
        await expect(readFile(join(dir, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
        await rm(join(dir, sidecar));
      }
    }
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(isolatedHome, { recursive: true, force: true });
  }
});

it("uses one JSON error envelope for Commander, invalid inputs, references, and sidecar reads", async () => {
  const path = join(home, "replay.json");
  await writeFile(
    path,
    JSON.stringify({
      meta: { sessionId: "error-session", provider: "codex" },
      scenes: [{ type: "user-prompt", content: "Original" }],
    }),
  );
  const cases = [
    ["inspect", "--json"],
    ["inspect", path, "--offest", "1", "--json"],
    ["sessions", "--limit", "--json"],
    ["sessions", "--limit", "0", "--json"],
    ["sessions", "--limit", "-1", "--json"],
    ["sessions", "--limit", "oops", "--json"],
    ["sessions", "--limit", "1.5", "--json"],
    ["sessions", "--limit", "101", "--json"],
    ["sessions", "--offset", "-1", "--json"],
    ["sessions", "--session", "missing-session", "--json"],
    ["inspect", "missing-session", "--json"],
    ["sessions", "--provider-filter", "unknown-provider", "--json"],
  ];
  for (const args of cases) {
    const result = await run(args);
    expect(result.code, args.join(" ")).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      suggestions: expect.any(Array),
    });
  }
  const typo = JSON.parse((await run(cases[1])).stderr);
  expect(typo.suggestions).toContain("--offset");
  await writeFile(join(home, "overlays.json"), "{");
  for (const args of [
    ["export", path, "--format", "json", "--json"],
    ["share", path, "--dry-run", "--json"],
  ]) {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "invalid-sidecar",
      suggestions: expect.arrayContaining([expect.stringContaining("backup")]),
    });
  }
  expect(await readFile(join(home, "overlays.json"), "utf-8")).toBe("{");
  await rm(join(home, "overlays.json"));
  const human = await run(["inspect", path, "--offest", "1"]);
  expect(human.stderr.match(/Did you mean/g)).toHaveLength(1);
  expect((await run(["inspect", "--help", "--json"])).code).toBe(0);
});

it("exports three formats with independent reports and diagnoses the final failure", async () => {
  const session = {
    meta: {
      sessionId: "paging-session",
      provider: "codex",
      title: "Build incident",
      stats: { userPrompts: 1, toolCalls: 499, sceneCount: 500, thinkingBlocks: 0 },
    },
    scenes: [
      { type: "user-prompt", content: "Investigate" },
      ...Array.from({ length: 499 }, (_, i) => ({
        type: "tool-call",
        toolName: "Bash",
        input: { command: `step ${i + 1}` },
        result: i === 0 ? `ghp_${"a".repeat(40)}` : `Failed ${i + 1}`,
        isError: true,
      })),
    ],
  };
  const path = join(home, "incident.json");
  await writeFile(path, JSON.stringify(session));
  const reports: Array<{ path: string; bytes: string; artifact: string }> = [];
  for (const format of ["markdown", "json", "html"]) {
    const result = await run([
      "export",
      path,
      "--format",
      format,
      "--output",
      join(home, "exports"),
      "--json",
    ]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(output.redactionsPath, "utf-8"));
    expect(report).toMatchObject({
      format,
      artifactSha256: createHash("sha256")
        .update(await readFile(output.path))
        .digest("hex"),
    });
    reports.push({
      path: output.redactionsPath,
      bytes: JSON.stringify(report),
      artifact: output.path,
    });
  }
  expect(new Set(reports.map((r) => r.path)).size).toBe(3);
  for (const report of reports) {
    expect(JSON.stringify(JSON.parse(await readFile(report.path, "utf-8")))).toBe(report.bytes);
    expect(
      createHash("sha256")
        .update(await readFile(report.artifact))
        .digest("hex"),
    ).toBe(JSON.parse(report.bytes).artifactSha256);
  }
  const first = JSON.parse((await run(["diagnose", path, "--limit", "100", "--json"])).stdout);
  const result = await run([
    "diagnose",
    path,
    "--limit",
    "100",
    "--offset",
    "400",
    "--revision",
    first.revision,
    "--signal-revision",
    first.signalRevision,
    "--json",
  ]);
  expect(result.code).toBe(0);
  const last = JSON.parse(result.stdout);
  expect(last.pagination.toolErrors).toMatchObject({ total: 499, returned: 99, truncated: false });
  expect(last.toolErrors.at(-1).index).toBe(499);
  const stale = await run(["diagnose", path, "--signal-revision", "stale", "--json"]);
  expect(JSON.parse(stale.stderr).code).toBe("revision-mismatch");
});
