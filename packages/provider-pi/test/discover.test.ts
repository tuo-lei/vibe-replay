import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDecodedProjectDirCache,
  decodeProjectDir,
  discoverPiSessions,
} from "../src/pi/discover.js";

const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  clearDecodedProjectDirCache();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("discoverPiSessions", () => {
  it("counts harness bash executions and apply_patch edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-pi-discover-"));
    tempDirs.push(root);
    const projectDir = join(root, "--Users-test-project--");
    await mkdir(projectDir, { recursive: true });
    const path = join(projectDir, "2026-01-01T00-00-00-000Z_session.jsonl");
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-discovery-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix auth" }] },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [
            {
              type: "toolCall",
              id: "patch-1",
              name: "apply_patch",
              arguments: { input: "*** Begin Patch\n*** Add File: auth.ts\n+ok\n*** End Patch" },
            },
            {
              type: "toolCall",
              id: "other-patch-1",
              name: "apply_patch",
              arguments: { operation: "custom" },
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "bashExecution", command: "pnpm test", output: "ok", exitCode: 0 },
      },
    ];
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
    process.env.PI_CODING_AGENT_SESSION_DIR = root;

    const sessions = await discoverPiSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "pi-discovery-session",
      promptCount: 1,
      toolCallCount: 3,
      editCountEst: 1,
      model: "gpt-5.5",
    });
  });

  it("can retain a readable transcript with no prompts for remote status display", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-pi-no-prompts-"));
    tempDirs.push(root);
    const projectDir = join(root, "--Users-test-project--");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "2026-01-01T00-00-00-000Z_metadata-only.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-metadata-only",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      })}\n`,
      "utf-8",
    );

    const sessions = await discoverPiSessions(root, false, true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "pi-metadata-only",
      transcriptStatus: "no-prompts",
      firstPrompt: "",
      promptCount: 0,
    });
  });

  it("uses file mtime for unreadable transcript fallback timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-pi-unreadable-"));
    tempDirs.push(root);
    const projectDir = join(root, "--Users-test-project--");
    await mkdir(projectDir, { recursive: true });
    const path = join(projectDir, "unreadable.jsonl");
    const mtime = new Date("2026-01-02T03:04:05.000Z");
    await writeFile(path, "{not-json}\n", "utf-8");
    await utimes(path, mtime, mtime);

    const sessions = await discoverPiSessions(root, false, true);
    expect(sessions[0]).toMatchObject({
      sessionId: "unreadable",
      timestamp: mtime.toISOString(),
      transcriptStatus: "unreadable",
    });
  });

  it("decodes hyphenated project dirs without splitting segment names", async () => {
    // vibe-replay and tuo-lei-com contain hyphens that naive split would break
    const tmpRoot = await mkdtemp(join(tmpdir(), "vibe-pi-decode-"));
    tempDirs.push(tmpRoot);
    // Create real directories so filesystem-aware decode can resolve them
    const realProject = join(tmpRoot, "real-fs");
    await mkdir(join(realProject, "Code", "vibe-replay"), { recursive: true });
    await mkdir(join(realProject, "Code", "tuo-lei-com"), { recursive: true });

    // Simulate Pi encoding: the directory name is the encoded path
    // For /tmp/.../real-fs/Code/vibe-replay -> encode as --tmp-...-real-fs-Code-vibe-replay--
    // But decodeProjectDir walks from / so we test the inner split logic directly
    // by using a real path that exists under /
    const decoded1 = await decodeProjectDir("--Users-tuo-Code-vibe-replay--");
    // On this machine /Users/tuo/Code/vibe-replay exists, so it should resolve correctly
    // If the filesystem walk fails (e.g. in CI without that path), fallback is naive
    // At minimum it should not crash and should return a string starting with /
    expect(typeof decoded1).toBe("string");
    expect(decoded1.startsWith("/")).toBe(true);

    // Direct hyphen preservation: create a temp structure to test deterministically
    const encoded = `--${realProject.replace(/^\//, "").replace(/\//g, "-")}--`;
    // Create the session dir structure Pi uses
    const sessionsRoot = await mkdtemp(join(tmpdir(), "vibe-pi-sessions-"));
    tempDirs.push(sessionsRoot);
    const vibeProjectDir = join(
      sessionsRoot,
      `--${join(realProject, "Code", "vibe-replay").replace(/^\//, "").replace(/\//g, "-")}--`,
    );
    await mkdir(vibeProjectDir, { recursive: true });
    await writeFile(
      join(vibeProjectDir, "2026-01-01T00-00-00-000Z_test.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "hyphen-test", timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
      "utf-8",
    );
    clearDecodedProjectDirCache();
    const sessions = await discoverPiSessions(sessionsRoot, false, false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].project).toBe(join(realProject, "Code", "vibe-replay"));
    expect(sessions[0].cwd).toBe(join(realProject, "Code", "vibe-replay"));

    void encoded;
  });

  it("falls back to naive decode when filesystem walk finds no match", async () => {
    clearDecodedProjectDirCache();
    const decoded = await decodeProjectDir("--nonexistent-path-with-dashes--");
    expect(decoded).toBe("/nonexistent/path/with/dashes");
  });
});
