import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
async function run(args: string[], home: string, defaultTelemetry = false) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: join(home, ".hermes"),
    VIBE_REPLAY_TELEMETRY: "0",
    VIBE_REPLAY_NO_AUTO_OPEN: "1",
  };
  if (defaultTelemetry) {
    for (const key of [
      "VIBE_REPLAY_TELEMETRY",
      "DO_NOT_TRACK",
      "VIBE_REPLAY_DEV",
      "VIBE_REPLAY_DEV_MENU",
      "CI",
    ])
      delete (env as Record<string, string | undefined>)[key];
  }
  try {
    return { ...(await exec(process.execPath, [cli, ...args], { env })), code: 0 };
  } catch (error) {
    const err = error as Error & { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

it("lists saved edits offline, follows their exact revision, and reports unavailable tool results", async () => {
  const home = await mkdtemp(join(tmpdir(), "vibe-offline-replays-"));
  try {
    for (const count of [30, 500]) {
      const dir = join(home, ".vibe-replay", `saved-${count}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "replay.json"),
        JSON.stringify({
          meta: {
            sessionId: `saved-${count}`,
            provider: "cursor",
            title: `Incident ${count}`,
            startTime: "2026-11-03T00:00:00Z",
            dataSourceInfo: {
              primary: "jsonl",
              sources: [],
              notes: ["Results were not persisted."],
            },
            stats: { userPrompts: 1, toolCalls: count - 1, sceneCount: count, thinkingBlocks: 0 },
          },
          scenes: [
            { type: "user-prompt", content: "ORIGINAL_PRIVATE_CANARY" },
            ...Array.from({ length: count - 1 }, () => ({
              type: "tool-call",
              toolName: "Bash",
              input: {},
              hasResult: false,
              isError: false,
            })),
          ],
        }),
      );
      await writeFile(
        join(dir, "overlays.json"),
        JSON.stringify({
          version: 1,
          overlays: [{ sceneIndex: 0, modifiedValue: "Details removed", updatedAt: "2026-11-03" }],
        }),
      );
      await writeFile(
        join(dir, "annotations.json"),
        JSON.stringify([{ id: "note", sceneIndex: 1, body: "Investigate" }]),
      );
    }
    // An unrelated active provider must not block default saved-ID fallback.
    await mkdir(join(home, ".hermes"), { recursive: true });
    await writeFile(
      join(home, ".hermes", "state.db"),
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(496)]),
    );
    await writeFile(join(home, ".hermes", "state.db-wal"), "Synthetic WAL");
    const exportFallback = await run(["export", "saved-30", "--format", "json", "--stdout"], home);
    expect(exportFallback.code).toBe(0);
    expect(JSON.parse(exportFallback.stdout).scenes[0].content).toBe("Details removed");
    const shareFallback = await run(["share", "saved-30", "--dry-run", "--json"], home);
    expect(shareFallback.code).toBe(0);
    expect(JSON.parse(shareFallback.stdout)).toMatchObject({
      uploaded: false,
      provenance: { origin: "snapshot" },
    });
    const hiddenDamaged = join(home, ".vibe-replay", "older-damaged");
    await mkdir(hiddenDamaged);
    await writeFile(
      join(hiddenDamaged, "replay.json"),
      JSON.stringify({
        meta: { sessionId: "older-damaged", provider: "cursor", startTime: "2025-01-01T00:00:00Z" },
        scenes: [{ type: "user-prompt", content: "Hidden original" }],
      }),
    );
    await writeFile(join(hiddenDamaged, "overlays.json"), "{");
    const partialText = await run(["replays", "--limit", "1"], home);
    expect(partialText.code).toBe(0);
    expect(partialText.stdout).toContain("Some saved snapshots or edits could not be read");
    expect(partialText.stdout).toContain("use --json for details");
    expect(partialText.stdout).not.toContain("Hidden original");
    await rm(hiddenDamaged, { recursive: true });
    const before = (await readdir(join(home, ".vibe-replay"))).sort();
    const first = await run(
      ["replays", "--provider", "cursor", "--limit", "1", "--json"],
      home,
      true,
    );
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const page = JSON.parse(first.stdout);
    expect(page.pagination).toMatchObject({ total: 2, returned: 1, nextOffset: 1 });
    expect(first.stdout).not.toContain("ORIGINAL_PRIVATE_CANARY");
    const second = await run(
      [
        "replays",
        "--provider",
        "cursor",
        "--limit",
        "1",
        "--offset",
        "1",
        "--revision",
        page.pagination.revision,
        "--json",
      ],
      home,
    );
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).replays[0].sessionId).not.toBe(page.replays[0].sessionId);
    const missing = await run(["replays", "--session", "missing", "--json"], home);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      code: "not-found",
      suggestions: ["vibe-replay replays --json"],
    });
    const item = page.replays[0];
    const selected = await run(
      ["--provider", "cursor", "--session", item.sessionId, "replays", "--json"],
      home,
    );
    expect(selected.code).toBe(0);
    expect(
      JSON.parse(selected.stdout).replays.map((replay: { sessionId: string }) => replay.sessionId),
    ).toEqual([item.sessionId]);
    expect(item).toMatchObject({
      origin: "snapshot",
      status: "ready",
      annotationCount: 1,
      editedSceneCount: 1,
    });
    const inspect = await run(
      ["inspect", item.replayPath, "--revision", item.revision, "--json"],
      home,
    );
    expect(inspect.code).toBe(0);
    const inspected = JSON.parse(inspect.stdout);
    expect(inspected.toolResultCoverage).toEqual({
      total: item.sceneCount - 1,
      available: 0,
      unavailable: item.sceneCount - 1,
      complete: false,
    });
    expect(inspected.dataQualityNotes).toContain("Results were not persisted.");
    const human = await run(["inspect", item.replayPath], home);
    expect(human.stdout).toContain("Tool results available: 0/");
    expect(human.stdout).toContain("Data quality: Results were not persisted.");
    const diagnosis = await run(["diagnose", item.replayPath, "--json"], home);
    expect(JSON.parse(diagnosis.stdout)).toMatchObject({
      toolErrorCount: 0,
      toolResultCoverage: { complete: false },
      dataQualityNotes: expect.arrayContaining([
        expect.stringContaining("zero observed tool errors"),
      ]),
    });
    expect((await readdir(join(home, ".vibe-replay"))).sort()).toEqual(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps WAL protection intact and returns actionable errors and read-mode discovery coverage", async () => {
  const home = await mkdtemp(join(tmpdir(), "vibe-read-mode-"));
  const dir = join(home, ".hermes");
  await mkdir(dir);
  const path = join(dir, "state.db");
  const bytes = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(496)]);
  const wal = Buffer.from("Synthetic active WAL guard fixture");
  await writeFile(path, bytes);
  await writeFile(`${path}-wal`, wal);
  try {
    const failed = await run(
      ["share", `${path}#session:fixture`, "--provider", "hermes", "--dry-run", "--json"],
      home,
    );
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(JSON.parse(failed.stderr)).toMatchObject({
      code: "checkpoint-required",
      suggestions: expect.arrayContaining([
        expect.stringContaining("replays --json"),
        expect.stringContaining("--output"),
        expect.stringContaining("./replay-recovery/replay.json"),
      ]),
    });
    const human = await run(
      ["export", `${path}#session:fixture`, "--provider", "hermes", "--format", "json", "--stdout"],
      home,
    );
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("Preflight the saved JSON");
    const doctor = await run(["doctor", "--provider", "hermes", "--read-only", "--json"], home);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      capability: "session-discovery",
      readOnly: true,
      partial: true,
      coverage: [
        expect.objectContaining({
          provider: "hermes",
          status: "failed",
          errorCode: "checkpoint-required",
        }),
      ],
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(`${path}-wal`)).toEqual(wal);
    expect((await readdir(dir)).sort()).toEqual(["state.db", "state.db-wal"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
