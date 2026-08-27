import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deduplicateSessionsByProvider } from "@vibe-replay/providers-default";
import { replayOutputSlug } from "../src/server-core.js";
import { discoverConfiguredRemoteSessions, parseRemoteSourceConfig } from "../src/remote.js";
import { scanCacheEntryKey } from "../src/scanner.js";
import { providerSessionKey, sourceSessionKey } from "../src/server-enrichment.js";
import type { SessionInfo } from "../src/types.js";
import { __testables } from "../src/remote.js";

const temporaryRoots: string[] = [];
const originalPath = process.env.PATH;
const originalFakeRemoteRoot = process.env.FAKE_REMOTE_ROOT;
const originalFakeSshLog = process.env.FAKE_SSH_LOG;
const originalFakeSshMode = process.env.FAKE_SSH_MODE;
const originalFakeIncludeMetadataOnly = process.env.FAKE_INCLUDE_METADATA_ONLY;
const originalFakeIncludeNoPrompt = process.env.FAKE_INCLUDE_NO_PROMPT;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalFakeRemoteRoot === undefined) delete process.env.FAKE_REMOTE_ROOT;
  else process.env.FAKE_REMOTE_ROOT = originalFakeRemoteRoot;
  if (originalFakeSshLog === undefined) delete process.env.FAKE_SSH_LOG;
  else process.env.FAKE_SSH_LOG = originalFakeSshLog;
  if (originalFakeSshMode === undefined) delete process.env.FAKE_SSH_MODE;
  else process.env.FAKE_SSH_MODE = originalFakeSshMode;
  if (originalFakeIncludeMetadataOnly === undefined) delete process.env.FAKE_INCLUDE_METADATA_ONLY;
  else process.env.FAKE_INCLUDE_METADATA_ONLY = originalFakeIncludeMetadataOnly;
  if (originalFakeIncludeNoPrompt === undefined) delete process.env.FAKE_INCLUDE_NO_PROMPT;
  else process.env.FAKE_INCLUDE_NO_PROMPT = originalFakeIncludeNoPrompt;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    provider: "codex",
    sessionId: "shared-session",
    slug: "shared-s",
    project: "~/project",
    cwd: "~/project",
    version: "",
    timestamp: "2026-08-24T10:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: "/tmp/session.jsonl",
    filePaths: ["/tmp/session.jsonl"],
    firstPrompt: "A useful prompt",
    ...overrides,
  };
}

describe("remote source configuration", () => {
  it("accepts safe targets, applies defaults, and ignores invalid entries", () => {
    expect(
      parseRemoteSourceConfig({
        remoteSources: [
          {
            id: "remote-dev",
            sshHost: "devbox",
            providers: ["codex", "codex", ""],
            connectTimeoutMs: 500,
          },
          { id: "remote-dev", sshHost: "other-host" },
          { id: "bad/id", sshHost: "devbox" },
          { id: "bad-host", sshHost: "-oProxyCommand=bad" },
          { id: "bad-space", sshHost: "dev box" },
        ],
      }),
    ).toEqual([
      {
        id: "remote-dev",
        sshHost: "devbox",
        label: "SSH · remote-dev",
        providers: ["codex"],
        connectTimeoutMs: 1_000,
      },
    ]);
  });

  it("uses all supported JSONL providers when providers are omitted", () => {
    expect(
      parseRemoteSourceConfig({
        remoteSources: [{ id: "remote-dev", sshHost: "devbox" }],
      })[0]?.providers,
    ).toEqual(["claude-code", "codex", "pi"]);
  });

  it("rejects the reserved local location id", () => {
    expect(
      parseRemoteSourceConfig({
        remoteSources: [{ id: "local", sshHost: "devbox" }],
      }),
    ).toEqual([]);
  });
});

describe("remote cache path safety and identity", () => {
  it("classifies lock failures before deciding whether cached sessions are safe to use", () => {
    expect(__testables.classifyRemoteCacheLockFailure(new Error("Remote cache is busy"))).toBe(
      "busy",
    );
    expect(
      __testables.classifyRemoteCacheLockFailure(new Error("Remote cache lock is unsafe")),
    ).toBe("unsafe");
    expect(
      __testables.classifyRemoteCacheLockFailure(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      ),
    ).toBe("permission");
    expect(__testables.classifyRemoteCacheLockFailure(new Error("unexpected IO failure"))).toBe(
      "io",
    );
  });

  it("rejects traversal, absolute, backslash, and ambiguous relative paths", () => {
    const safeRelativePath = __testables.safeRelativePath;
    expect(safeRelativePath(".codex/sessions/rollout.jsonl")).toBe(".codex/sessions/rollout.jsonl");
    for (const value of [
      "../rollout.jsonl",
      "nested/../rollout.jsonl",
      "/tmp/rollout.jsonl",
      "C:/tmp/rollout.jsonl",
      "C:tmp/rollout.jsonl",
      ".codex\\sessions\\rollout.jsonl",
      ".codex//sessions/rollout.jsonl",
      ".codex/./sessions/rollout.jsonl",
    ]) {
      expect(safeRelativePath(value)).toBeNull();
    }
  });

  it("rejects a cache root symlink before reading cached files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-remote-cache-root-"));
    temporaryRoots.push(root);
    const outside = join(root, "outside");
    const cacheRoot = join(root, "cache");
    await mkdir(outside);
    await symlink(outside, cacheRoot, "dir");

    await expect(
      __testables.inspectCachedPath(cacheRoot, ".codex/sessions/rollout.jsonl"),
    ).resolves.toEqual({ status: "unsafe" });
  });

  it("binds cache directories to the configured SSH endpoint", () => {
    const base = {
      id: "remote-dev",
      label: "Remote dev",
      providers: ["codex"],
      connectTimeoutMs: 10_000,
    };
    const first = __testables.cacheRootForTarget({ ...base, sshHost: "host-a" }, "/tmp/cache");
    const second = __testables.cacheRootForTarget({ ...base, sshHost: "host-b" }, "/tmp/cache");

    expect(first).not.toBe(second);
    expect(first).not.toContain("host-a");
    expect(second).not.toContain("host-b");
  });

  it("preserves providers outside a provider-scoped cache refresh", () => {
    const entries = {
      ".codex/sessions/codex.jsonl": {
        remotePath: "/home/test/.codex/sessions/codex.jsonl",
        size: 10,
        mtimeMs: 1,
      },
      ".claude/projects/project/claude.jsonl": {
        remotePath: "/home/test/.claude/projects/project/claude.jsonl",
        size: 20,
        mtimeMs: 2,
      },
      ".pi/agent/sessions/project/pi.jsonl": {
        remotePath: "/home/test/.pi/agent/sessions/project/pi.jsonl",
        size: 30,
        mtimeMs: 3,
      },
    };

    expect(__testables.preservedRemoteEntries(entries, new Set(["codex"]))).toEqual({
      ".claude/projects/project/claude.jsonl": entries[".claude/projects/project/claude.jsonl"],
      ".pi/agent/sessions/project/pi.jsonl": entries[".pi/agent/sessions/project/pi.jsonl"],
    });
  });

  it("serializes cache access and only removes stale locks from dead owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-remote-lock-"));
    temporaryRoots.push(root);
    const cacheRoot = join(root, "cache", "target");
    const release = await __testables.acquireRemoteCacheLock(cacheRoot);

    await expect(__testables.acquireRemoteCacheLock(cacheRoot, 20)).rejects.toThrow(
      "Remote cache is busy",
    );
    await release();

    const activeLock = `${cacheRoot}-active.lock`;
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(activeLock, `${process.pid}\n`, "utf-8");
    await utimes(activeLock, new Date(0), new Date(0));
    await expect(__testables.acquireRemoteCacheLock(`${cacheRoot}-active`, 20, 0)).rejects.toThrow(
      "Remote cache is busy",
    );
    expect(await readFile(activeLock, "utf-8")).toBe(`${process.pid}\n`);

    const recentDeadLock = `${cacheRoot}-recent-dead`;
    await writeFile(`${recentDeadLock}.lock`, "999999999\n", "utf-8");
    const releaseRecentDead = await __testables.acquireRemoteCacheLock(
      recentDeadLock,
      20,
      60 * 60 * 1_000,
    );
    await releaseRecentDead();

    const replacedLockRoot = `${cacheRoot}-replaced`;
    const releaseReplaced = await __testables.acquireRemoteCacheLock(replacedLockRoot);
    const replacedLock = `${replacedLockRoot}.lock`;
    await writeFile(replacedLock, "new-owner\n", "utf-8");
    await releaseReplaced();
    expect(await readFile(replacedLock, "utf-8")).toBe("new-owner\n");
    await unlink(replacedLock);

    const deadLock = `${cacheRoot}-dead.lock`;
    await writeFile(deadLock, "999999999\n", "utf-8");
    await utimes(deadLock, new Date(0), new Date(0));
    const releaseDead = await __testables.acquireRemoteCacheLock(`${cacheRoot}-dead`, 20, 0);
    await releaseDead();
  });

  it("keeps local and SSH identities separate across caches and providers", () => {
    const local = session();
    const remoteA = session({
      location: { kind: "ssh", id: "remote-a", label: "A" },
    });
    const remoteB = session({
      location: { kind: "ssh", id: "remote-b", label: "B" },
    });

    expect(deduplicateSessionsByProvider([local, remoteA, remoteB])).toHaveLength(3);
    expect(sourceSessionKey("codex", "~/project", "shared-s")).not.toBe(
      sourceSessionKey("codex", "~/project", "shared-s", "remote-a"),
    );
    expect(providerSessionKey("codex", "shared-session", "remote-a")).not.toBe(
      providerSessionKey("codex", "shared-session", "remote-b"),
    );
    expect(
      scanCacheEntryKey({
        provider: "codex",
        sessionId: "shared-session",
        location: remoteA.location,
      }),
    ).not.toBe(
      scanCacheEntryKey({
        provider: "codex",
        sessionId: "shared-session",
        location: remoteB.location,
      }),
    );
    expect(replayOutputSlug("shared-s", remoteA.location)).not.toBe(
      replayOutputSlug("shared-s", remoteB.location),
    );
    expect(replayOutputSlug("shared-s", remoteA.location)).not.toContain("remote-a");
    expect(
      replayOutputSlug("shared-s", remoteA.location, {
        provider: "codex",
        sessionId: "session-a",
      }),
    ).not.toBe(
      replayOutputSlug("shared-s", remoteA.location, {
        provider: "codex",
        sessionId: "session-b",
      }),
    );
  });
});

describe("remote metadata protocols", () => {
  it("rejects a framed remote index that did not finish", () => {
    expect(() =>
      __testables.parseRemoteIndex(Buffer.from("protocol\t2\nhome\t/home/test\n")),
    ).toThrow("Remote session index was incomplete");
  });

  it("rejects remote files larger than the bounded transfer limit", () => {
    expect(() =>
      __testables.parseRemoteIndex(
        Buffer.from(
          [
            "protocol\t2",
            "home\t/home/test",
            "file\tcodex\t/home/test/huge.jsonl\t.codex/sessions/huge.jsonl\t536870913\t1",
            "complete",
          ].join("\n"),
        ),
      ),
    ).toThrow("Remote session file exceeds the transfer limit");
  });

  it("parses Codex JSON metadata from both line and array responses", () => {
    const lineResponse = __testables.parseRemoteCodexMetadata(
      Buffer.from(
        '{"type":"status","available":true}\n{"type":"thread","sessionId":"thread-a","title":"A title","updatedAtMs":1756031700000}\n',
      ),
    );
    expect(lineResponse.available).toBe(true);
    expect(lineResponse.entries.get("thread-a")).toMatchObject({
      sessionId: "thread-a",
      title: "A title",
      updatedAtMs: 1756031700000,
    });

    const arrayResponse = __testables.parseRemoteCodexMetadata(
      Buffer.from('[{"id":"thread-b","title":"B title","updated_at":"2026-08-24T10:00:00.000Z"}]'),
    );
    expect(arrayResponse.available).toBe(false);
    expect(arrayResponse.entries.get("thread-b")).toMatchObject({
      sessionId: "thread-b",
      title: "B title",
      updatedAt: "2026-08-24T10:00:00.000Z",
    });

    const mixedResponse = __testables.parseRemoteCodexMetadata(
      Buffer.from('{"type":"status","available":true}\n[{"id":"thread-c","title":"C title"}]\n'),
    );
    expect(mixedResponse.available).toBe(true);
    expect(mixedResponse.entries.get("thread-c")).toMatchObject({
      sessionId: "thread-c",
      title: "C title",
    });
  });

  it("preserves NUL-delimited remote git paths and normalizes origin URLs", () => {
    const repos = __testables.parseRemoteGitMetadata(
      Buffer.from(
        "repo\0/home/user/project\0git@github.com:example/project.git\0repo\0/home/user/other\0\0",
      ),
    );
    expect(repos.get("/home/user/project")).toBe("example/project");
    expect(repos.has("/home/user/other")).toBe(true);
    expect(repos.get("/home/user/other")).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("configured remote discovery", () => {
  it("uses OpenSSH transport, materializes JSONL, and refreshes changed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-remote-test-"));
    temporaryRoots.push(root);
    const fakeRemoteRoot = join(root, "remote-home");
    const remoteSessionDir = join(fakeRemoteRoot, ".codex", "sessions");
    const fakeBinDir = join(root, "bin");
    const cacheRoot = join(root, "cache");
    const configPath = join(root, "config.json");
    const sshLogPath = join(root, "ssh.log");
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(remoteSessionDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(fakeBinDir, "ssh"),
        String.raw`#!/bin/sh
set -eu
shift 8
case "$1" in
  sh)
    script=$(cat)
    case "$script" in
      *VIBE_REPLAY_CODEX_METADATA*)
        if [ "$FAKE_SSH_MODE" = "offline" ]; then
          exit 1
        fi
        printf '{"type":"status","available":true}\n'
        printf '{"type":"thread","sessionId":"remote-session","title":"Remote /resume title","cwd":"/remote/home/projects/app","gitBranch":"main","model":"gpt-test","updatedAt":"2026-08-24T10:05:00.000Z"}\n'
        if [ "$FAKE_INCLUDE_METADATA_ONLY" = "yes" ]; then
          printf '{"type":"thread","sessionId":"metadata-only","title":"Metadata-only /resume title","cwd":"/remote/home/projects/old","updatedAt":"2026-08-24T09:00:00.000Z"}\n'
        fi
        ;;
      *VIBE_REPLAY_GIT_METADATA*)
        if [ "$FAKE_SSH_MODE" = "offline" ]; then
          exit 1
        fi
        printf 'repo\0/remote/home/projects/app\0https://github.com/example/project.git\0'
        ;;
      *)
        if [ "$FAKE_SSH_MODE" = "offline" ]; then
          exit 1
        fi
        file="$FAKE_REMOTE_ROOT/.codex/sessions/rollout-fake.jsonl"
        size=$(wc -c < "$file" | tr -d '[:space:]')
        printf 'protocol\t2\n'
        printf 'home\t/remote/home\n'
        printf 'file\tcodex\t/remote/home/.codex/sessions/rollout-fake.jsonl\t.codex/sessions/rollout-fake.jsonl\t%s\t1700000000\n' "$size"
        if [ "$FAKE_INCLUDE_NO_PROMPT" = "yes" ]; then
          no_prompt="$FAKE_REMOTE_ROOT/.codex/sessions/rollout-no-prompts.jsonl"
          no_size=$(wc -c < "$no_prompt" | tr -d '[:space:]')
          printf 'file\tcodex\t/remote/home/.codex/sessions/rollout-no-prompts.jsonl\t.codex/sessions/rollout-no-prompts.jsonl\t%s\t1700000000\n' "$no_size"
        fi
        printf 'complete\n'
        ;;
    esac
    ;;
  set*)
    printf 'batch\n' >> "$FAKE_SSH_LOG"
    if [ "$FAKE_SSH_MODE" = "tar-fails" ]; then
      exit 1
    fi
    case "$1" in
      *rollout-fake.jsonl*)
        file="$FAKE_REMOTE_ROOT/.codex/sessions/rollout-fake.jsonl"
        size=$(wc -c < "$file" | tr -d '[:space:]')
        printf '%s\n' "$size"
        cat "$file"
        if [ "$FAKE_SSH_MODE" = "oversized" ]; then
          printf 'overflow'
        fi
        ;;
    esac
    case "$1" in
      *rollout-no-prompts.jsonl*)
        file="$FAKE_REMOTE_ROOT/.codex/sessions/rollout-no-prompts.jsonl"
        size=$(wc -c < "$file" | tr -d '[:space:]')
        printf '%s\n' "$size"
        cat "$file"
        ;;
    esac
    ;;
  'tar -czf - -C "$HOME" --null --verbatim-files-from -T -')
    printf 'tar\n' >> "$FAKE_SSH_LOG"
    if [ "$FAKE_SSH_MODE" = "tar-fails" ]; then
      exit 1
    fi
    tr '\0' '\n' | tar -czf - -C "$FAKE_REMOTE_ROOT" -T -
    ;;
  cat*)
    printf 'cat\n' >> "$FAKE_SSH_LOG"
    cat "$FAKE_REMOTE_ROOT/.codex/sessions/rollout-fake.jsonl"
    if [ "$FAKE_SSH_MODE" = "oversized" ]; then
      printf 'overflow'
    fi
    ;;
  *)
    exit 1
    ;;
esac
`,
        "utf-8",
      ),
      writeFile(
        configPath,
        JSON.stringify({
          remoteSources: [
            {
              id: "fake-remote",
              label: "Test remote",
              sshHost: "fake-host",
              providers: ["codex"],
            },
          ],
        }),
        "utf-8",
      ),
      writeFile(sshLogPath, "", "utf-8"),
    ]);
    await chmod(join(fakeBinDir, "ssh"), 0o755);
    await writeFile(
      join(remoteSessionDir, "rollout-fake.jsonl"),
      codexRollout("Please inspect the remote project"),
      "utf-8",
    );

    process.env.FAKE_REMOTE_ROOT = fakeRemoteRoot;
    process.env.FAKE_SSH_LOG = sshLogPath;
    process.env.FAKE_SSH_MODE = "normal";
    process.env.FAKE_INCLUDE_METADATA_ONLY = "no";
    process.env.FAKE_INCLUDE_NO_PROMPT = "no";
    process.env.PATH = `${fakeBinDir}:${originalPath || ""}`;

    const first = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(first.failedTargets).toEqual([]);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({
      provider: "codex",
      location: { kind: "ssh", id: "fake-remote", label: "Test remote" },
      project: "~/projects/app",
      cwd: "~/projects/app",
      title: "Remote /resume title",
      gitRepo: "example/project",
      firstPrompt: "Please inspect the remote project",
    });
    expect(first.sessions[0]?.filePath).toContain(cacheRoot);
    expect(await readFile(sshLogPath, "utf-8")).toBe("batch\n");

    const unchanged = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(unchanged.sessions[0]?.firstPrompt).toBe("Please inspect the remote project");
    expect(await readFile(sshLogPath, "utf-8")).toBe("batch\n");

    await writeFile(
      join(remoteSessionDir, "rollout-fake.jsonl"),
      codexRollout("Please inspect the remote project and update the tests"),
      "utf-8",
    );
    const refreshed = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(refreshed.sessions[0]?.firstPrompt).toBe(
      "Please inspect the remote project and update the tests",
    );
    expect(await readFile(sshLogPath, "utf-8")).toBe("batch\nbatch\n");

    process.env.FAKE_SSH_MODE = "tar-fails";
    await writeFile(
      join(remoteSessionDir, "rollout-fake.jsonl"),
      codexRollout("Please inspect the remote project through the fallback path now"),
      "utf-8",
    );
    const fallback = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(fallback.failedTargets).toEqual([]);
    expect(fallback.sessions[0]?.firstPrompt).toBe(
      "Please inspect the remote project through the fallback path now",
    );
    expect(await readFile(sshLogPath, "utf-8")).toBe("batch\nbatch\nbatch\ncat\n");

    await writeFile(
      join(remoteSessionDir, "rollout-fake.jsonl"),
      codexRollout("This oversized transfer must never replace the last good cached transcript"),
      "utf-8",
    );
    process.env.FAKE_SSH_MODE = "oversized";
    const oversized = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(oversized.failedTargets).toEqual(["fake-remote"]);
    expect(oversized.sessions[0]?.firstPrompt).toBe(
      "Please inspect the remote project through the fallback path now",
    );
    expect(
      oversized.sessions.some((session) => session.sessionId.includes("rollout-fake.jsonl")),
    ).toBe(false);
    await writeFile(
      join(remoteSessionDir, "rollout-fake.jsonl"),
      codexRollout("Please inspect the remote project through the fallback path now"),
      "utf-8",
    );

    await writeFile(
      join(remoteSessionDir, "rollout-no-prompts.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-24T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "no-prompts", cwd: "/remote/home/projects/old" },
      })}\n`,
      "utf-8",
    );
    process.env.FAKE_SSH_MODE = "normal";
    process.env.FAKE_INCLUDE_NO_PROMPT = "yes";
    const noPrompt = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(
      noPrompt.sessions.find((candidate) => candidate.sessionId === "no-prompts"),
    ).toMatchObject({
      transcriptStatus: "no-prompts",
      firstPrompt: "",
      project: "~/projects/old",
    });
    process.env.FAKE_INCLUDE_NO_PROMPT = "no";

    process.env.FAKE_INCLUDE_METADATA_ONLY = "yes";
    const withMetadataOnly = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    const metadataOnly = withMetadataOnly.sessions.find(
      (candidate) => candidate.sessionId === "metadata-only",
    );
    expect(metadataOnly).toMatchObject({
      title: "Metadata-only /resume title",
      project: "~/projects/old",
      cwd: "~/projects/old",
      firstPrompt: "",
      transcriptStatus: "unreadable",
    });
    expect(metadataOnly?.filePaths).toEqual([]);

    process.env.FAKE_INCLUDE_METADATA_ONLY = "no";
    process.env.FAKE_SSH_MODE = "offline";
    const cachedFailure = await discoverConfiguredRemoteSessions(["codex"], {
      configPath,
      cacheRoot,
    });
    expect(cachedFailure.failedTargets).toEqual(["fake-remote"]);
    expect(cachedFailure.sessions[0]?.firstPrompt).toBe(
      "Please inspect the remote project through the fallback path now",
    );
    expect(cachedFailure.sessions[0]?.title).toBe("Remote /resume title");
    expect(cachedFailure.sessions[0]?.gitRepo).toBe("example/project");
  });
});

function codexRollout(prompt: string): string {
  return `${[
    {
      timestamp: "2026-08-24T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "remote-session",
        cwd: "/remote/home/projects/app",
        cli_version: "0.1.0",
      },
    },
    {
      timestamp: "2026-08-24T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: prompt },
    },
    {
      timestamp: "2026-08-24T10:00:01.500Z",
      type: "event_msg",
      payload: { type: "thread_name_updated", thread_name: "JSONL fallback title" },
    },
    {
      timestamp: "2026-08-24T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect it." }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
}
