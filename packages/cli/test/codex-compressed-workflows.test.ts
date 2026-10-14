import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCodexSessionInfo } from "@vibe-replay/provider-codex/discover";
import { parseCodexSession } from "@vibe-replay/provider-codex/parser";
import { discoverConfiguredRemoteSessions } from "../src/remote.js";
import { registerLiveRoutes } from "../src/server-routes/live.js";
import { resolveCliSource } from "../src/session-workflows.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-compressed-workflows-"));
  roots.push(root);
  const sessions = join(root, "remote-home", ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, "rollout-2026-10-13-test-session.jsonl");
  const text = `${[
    { type: "session_meta", payload: { id: "test-session", cwd: "/example/project" } },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Inspect the compressed session" },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "Inspection complete" },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
  const bytes = zstdCompressSync(Buffer.from(text));
  await writeFile(`${path}.zst`, bytes);
  const info = await extractCodexSessionInfo(`${path}.zst`, bytes.length);
  if (!info) throw new Error("Fixture must be discoverable");
  return { root, path, text, bytes, info };
}

describe("Codex compressed source workflows", () => {
  it("infers an explicit compressed source and resolves its logical .jsonl alias", async () => {
    const { path, info } = await fixture();
    const discovery = {
      sessions: [info],
      coverage: [],
      failedProviders: [],
      source: "fixture",
      updatedAt: "2026-10-13T00:00:00Z",
    };
    const explicit = await resolveCliSource(`${path}.zst`, { readOnly: true }, discovery);
    const logical = await resolveCliSource(path, { readOnly: true }, discovery);
    expect(explicit.provider).toBe("codex");
    expect(explicit.paths).toEqual([`${path}.zst`]);
    expect(logical.paths).toEqual(explicit.paths);
    expect((await parseCodexSession(explicit.paths)).turns).toHaveLength(2);
  });

  it("opens compressed sessions in Live mode and follows a materialized plain sibling", async () => {
    const { path, info, text } = await fixture();
    const app = new Hono();
    registerLiveRoutes(app, { resolveSessionInfo: async () => info });
    const response = await app.request("/api/live?provider=codex&sessionId=test-session");
    const reader = response.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('"type":"session"');
      expect(first).toContain("Inspect the compressed session");
      await writeFile(path, text.replace("Inspection complete", "Updated inspection"));
      await unlink(`${path}.zst`);
      const next = new TextDecoder().decode((await reader.read()).value);
      expect(next).toContain("Updated inspection");
    } finally {
      await reader.cancel();
    }
  }, 20_000);

  it("updates Live promptly when a plain sibling is created while compression remains", async () => {
    const { path, info, text } = await fixture();
    const app = new Hono();
    registerLiveRoutes(app, { resolveSessionInfo: async () => info });
    const response = await app.request("/api/live?provider=codex&sessionId=test-session");
    const reader = response.body!.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("Inspection complete");
      await writeFile(path, text.replace("Inspection complete", "Resumed with plain storage"));
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Live did not detect its new sibling")),
            4000,
          );
        }),
      ]);
      expect(new TextDecoder().decode(next.value)).toContain("Resumed with plain storage");
      expect(await readFile(`${path}.zst`)).toEqual(zstdCompressSync(Buffer.from(text)));
    } finally {
      clearTimeout(timeout);
      await reader.cancel();
    }
  });

  it.skipIf(process.platform === "win32")(
    "indexes and stages compressed SSH sources without a remote decoder",
    async () => {
      const { root, path, text, bytes } = await fixture();
      const bin = join(root, "bin");
      await mkdir(bin);
      const ssh = join(bin, "ssh");
      await writeFile(
        ssh,
        `#!/bin/sh\nshift 8\nHOME="$FAKE_REMOTE_ROOT"\nCODEX_HOME="$HOME/.codex"\nCODEX_SQLITE_HOME="$CODEX_HOME"\nexport HOME CODEX_HOME CODEX_SQLITE_HOME\nexec /bin/sh -c "$*"\n`,
      );
      await chmod(ssh, 0o755);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      vi.stubEnv("FAKE_REMOTE_ROOT", join(root, "remote-home"));
      const configPath = join(root, "config.json");
      const cacheRoot = join(root, "cache");
      await writeFile(
        configPath,
        JSON.stringify({
          remoteSources: [{ id: "compressed", sshHost: "fixture-host", providers: ["codex"] }],
        }),
      );
      const result = await discoverConfiguredRemoteSessions(["codex"], { configPath, cacheRoot });
      expect(result.failedTargets).toEqual([]);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        sessionId: "test-session",
        transcriptStatus: undefined,
        location: { kind: "ssh", id: "compressed" },
      });
      expect(await readFile(result.sessions[0]!.filePath)).toEqual(bytes);
      expect((await parseCodexSession(result.sessions[0]!.filePaths)).turns).toHaveLength(2);
      const cached = await discoverConfiguredRemoteSessions(["codex"], {
        configPath,
        cacheRoot,
        readOnly: true,
      });
      expect(cached.sessions[0]?.filePath).toBe(result.sessions[0]!.filePath);
      await writeFile(path, text);
      const mixed = await discoverConfiguredRemoteSessions(["codex"], { configPath, cacheRoot });
      expect(mixed.sessions).toHaveLength(1);
      expect(mixed.sessions[0]?.filePath.endsWith(".jsonl")).toBe(true);
      await unlink(`${path}.zst`);
      const refreshed = await discoverConfiguredRemoteSessions(["codex"], {
        configPath,
        cacheRoot,
      });
      expect(refreshed.sessions).toHaveLength(1);
      expect(refreshed.sessions[0]?.filePath.endsWith(".jsonl")).toBe(true);
    },
  );
});
