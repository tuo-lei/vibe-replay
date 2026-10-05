import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testables,
  discoverConfiguredRemoteSessions,
  parseRemoteSourceConfig,
} from "../src/remote.js";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error("Read-only discovery must never start SSH");
  }),
}));
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "vibe-read-only-remote-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  const config = {
    remoteSources: [{ id: "remote", sshHost: "unreachable-test-host", providers: ["codex"] }],
  };
  await writeFile(configPath, JSON.stringify(config));
  const cacheRoot = join(root, "cache");
  const targetRoot = __testables.cacheRootForTarget(parseRemoteSourceConfig(config)[0], cacheRoot);
  return { root, configPath, cacheRoot, targetRoot };
}
async function snapshot(path: string): Promise<unknown[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const file = join(path, entry.name);
        const info = await stat(file);
        return [
          entry.name,
          info.mtimeMs,
          entry.isDirectory() ? await snapshot(file) : await readFile(file, "utf-8"),
        ];
      }),
  );
}

describe("read-only SSH discovery", () => {
  it("reads a staged session without SSH, locks, downloads, or manifest updates", async () => {
    const { root, configPath, cacheRoot, targetRoot } = await setup();
    const sessionDir = join(targetRoot, ".codex", "sessions");
    await mkdir(sessionDir, { recursive: true });
    const records = [
      {
        timestamp: "2026-10-04T00:00:00Z",
        type: "session_meta",
        payload: { id: "cached-remote", cwd: "/remote/home/project" },
      },
      {
        timestamp: "2026-10-04T00:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Inspect the staged session" },
      },
    ];
    await writeFile(
      join(sessionDir, "rollout.jsonl"),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    await writeFile(
      join(targetRoot, ".manifest.json"),
      JSON.stringify({
        version: 2,
        home: "/remote/home",
        entries: {},
        codexMetadata: {},
        gitRepos: {},
      }),
    );
    const before = await snapshot(root);
    const result = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
      readOnly: true,
    });
    expect(result.failedTargets).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "cached-remote",
      firstPrompt: "Inspect the staged session",
      cwd: "~/project",
      location: { kind: "ssh", id: "remote" },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });

  it("reports an unstaged target without creating its cache directory", async () => {
    const { root, configPath, cacheRoot } = await setup();
    const before = await snapshot(root);
    const result = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
      readOnly: true,
    });
    expect(result).toEqual({ sessions: [], failedTargets: ["remote"] });
    expect(spawn).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });
});
