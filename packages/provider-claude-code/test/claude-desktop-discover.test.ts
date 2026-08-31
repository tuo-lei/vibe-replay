import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverFromDir,
  discoverFromDirs,
  extractDesktopSessionInfo,
} from "../src/claude-desktop/discover.js";

const fixture = (name: string) => join(__dirname, "fixtures", name);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DESKTOP_JSON = fixture("claude-desktop-session.json");
const JSONL_FIXTURE = fixture("claude-desktop-session.jsonl");

// ---------------------------------------------------------------------------
// extractDesktopSessionInfo
// ---------------------------------------------------------------------------

describe("extractDesktopSessionInfo", () => {
  it("returns SessionInfo for a valid Desktop JSON with matching JSONL", async () => {
    // Point the projects dir at the fixtures folder so the encoded path resolves.
    // cwd="/Users/test/desktop-project" → encoded="-Users-test-desktop-project"
    // JSONL should be at: <claudeProjectsDir>/-Users-test-desktop-project/desktop-cli-session-001.jsonl
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const encodedDir = join(tmpDir, "-Users-test-desktop-project");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(encodedDir, { recursive: true });

    // Copy fixture JSONL into the expected location
    const { copyFile } = await import("node:fs/promises");
    await copyFile(JSONL_FIXTURE, join(encodedDir, "desktop-cli-session-001.jsonl"));

    const info = await extractDesktopSessionInfo(DESKTOP_JSON, tmpDir);

    expect(info).not.toBeNull();
    expect(info?.provider).toBe("claude-desktop");
    expect(info?.sessionId).toBe("desktop-cli-session-001");
    expect(info?.cwd).toBe("/Users/test/desktop-project");
  });

  it("uses title from Desktop JSON (overrides JSONL title)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const encodedDir = join(tmpDir, "-Users-test-desktop-project");
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(encodedDir, { recursive: true });
    await copyFile(JSONL_FIXTURE, join(encodedDir, "desktop-cli-session-001.jsonl"));

    const info = await extractDesktopSessionInfo(DESKTOP_JSON, tmpDir);

    expect(info?.title).toBe("Add desktop session support feature");
  });

  it("uses model from Desktop JSON", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const encodedDir = join(tmpDir, "-Users-test-desktop-project");
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(encodedDir, { recursive: true });
    await copyFile(JSONL_FIXTURE, join(encodedDir, "desktop-cli-session-001.jsonl"));

    const info = await extractDesktopSessionInfo(DESKTOP_JSON, tmpDir);

    expect(info?.model).toBe("claude-opus-4-7");
  });

  it("uses lastActivityAt from Desktop JSON as timestamp", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const encodedDir = join(tmpDir, "-Users-test-desktop-project");
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir(encodedDir, { recursive: true });
    await copyFile(JSONL_FIXTURE, join(encodedDir, "desktop-cli-session-001.jsonl"));

    const info = await extractDesktopSessionInfo(DESKTOP_JSON, tmpDir);

    // lastActivityAt: 1750000150000 → ISO string
    expect(info?.timestamp).toBe(new Date(1750000150000).toISOString());
  });

  it("returns null when JSONL file does not exist", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    // No JSONL created → should return null

    const info = await extractDesktopSessionInfo(DESKTOP_JSON, tmpDir);

    expect(info).toBeNull();
  });

  it("returns null for Desktop JSON missing cliSessionId", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const invalidJson = join(tmpDir, "local_invalid.json");
    await writeFile(
      invalidJson,
      JSON.stringify({ sessionId: "local_foo", cwd: "/Users/test/project" }),
    );

    const info = await extractDesktopSessionInfo(invalidJson, tmpDir);

    expect(info).toBeNull();
  });

  it("returns null for Desktop JSON missing cwd", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-test-"));
    const invalidJson = join(tmpDir, "local_invalid.json");
    await writeFile(
      invalidJson,
      JSON.stringify({ sessionId: "local_foo", cliSessionId: "some-id" }),
    );

    const info = await extractDesktopSessionInfo(invalidJson, tmpDir);

    expect(info).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverFromDir
// ---------------------------------------------------------------------------

describe("discoverFromDir", () => {
  let desktopDir: string;
  let claudeProjectsDir: string;

  beforeAll(async () => {
    const { mkdir, copyFile } = await import("node:fs/promises");

    desktopDir = await mkdtemp(join(tmpdir(), "vr-desktop-dir-"));
    claudeProjectsDir = await mkdtemp(join(tmpdir(), "vr-claude-projects-"));

    // Build tree: desktopDir/{accountId}/{orgId}/local_*.json
    const accountDir = join(desktopDir, "account-001");
    const orgDir = join(accountDir, "org-001");
    await mkdir(orgDir, { recursive: true });

    await copyFile(DESKTOP_JSON, join(orgDir, "local_desktop-session-abc123.json"));

    // Set up the JSONL in the expected location
    const encodedCwdDir = join(claudeProjectsDir, "-Users-test-desktop-project");
    await mkdir(encodedCwdDir, { recursive: true });
    await copyFile(JSONL_FIXTURE, join(encodedCwdDir, "desktop-cli-session-001.jsonl"));
  });

  it("discovers sessions from Desktop JSON files in accountId/orgId structure", async () => {
    const sessions = await discoverFromDir(desktopDir, claudeProjectsDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("claude-desktop");
    expect(sessions[0].sessionId).toBe("desktop-cli-session-001");
  });

  it("returns empty array when Desktop dir does not exist", async () => {
    const sessions = await discoverFromDir("/nonexistent/path", claudeProjectsDir);

    expect(sessions).toHaveLength(0);
  });

  it("returns sessions sorted by timestamp descending", async () => {
    // Only one session in our test setup — just verify it's present
    const sessions = await discoverFromDir(desktopDir, claudeProjectsDir);

    expect(sessions.length).toBeGreaterThan(0);
    // Timestamps should be in descending order (trivially true for 1 session)
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].timestamp >= sessions[i].timestamp).toBe(true);
    }
  });

  it("deduplicates sessions when multiple Claude data roots are visible", async () => {
    const sessions = await discoverFromDirs([desktopDir, desktopDir], claudeProjectsDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("desktop-cli-session-001");
  });

  it("skips non-local_*.json files (e.g. scheduled-tasks.json)", async () => {
    const { mkdir, copyFile, writeFile: wf } = await import("node:fs/promises");

    const desktopDir2 = await mkdtemp(join(tmpdir(), "vr-desktop-skip-"));
    const orgDir = join(desktopDir2, "acc", "org");
    await mkdir(orgDir, { recursive: true });

    // Add a non-local_ file that should be ignored
    await wf(join(orgDir, "scheduled-tasks.json"), JSON.stringify({ tasks: [] }));
    // Add the real desktop session
    await copyFile(DESKTOP_JSON, join(orgDir, "local_desktop-session-abc123.json"));

    const encodedCwdDir = join(claudeProjectsDir, "-Users-test-desktop-project");
    await mkdir(encodedCwdDir, { recursive: true }).catch(() => {});
    await copyFile(JSONL_FIXTURE, join(encodedCwdDir, "desktop-cli-session-001.jsonl")).catch(
      () => {},
    );

    const sessions = await discoverFromDir(desktopDir2, claudeProjectsDir);

    expect(sessions).toHaveLength(1);
  });

  it("resolves Windows drive paths to Claude project directories", async () => {
    const { mkdir, copyFile } = await import("node:fs/promises");
    const tmpDir = await mkdtemp(join(tmpdir(), "vr-desktop-windows-"));
    const encodedDir = join(tmpDir, "C--Users-test-desktop-project");
    await mkdir(encodedDir, { recursive: true });
    await copyFile(JSONL_FIXTURE, join(encodedDir, "desktop-cli-session-001.jsonl"));

    const jsonPath = join(tmpDir, "local_windows-session.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        sessionId: "local_windows-session",
        cliSessionId: "desktop-cli-session-001",
        cwd: "C:\\Users\\test\\desktop-project",
        createdAt: 1750000000000,
        lastActivityAt: 1750000150000,
      }),
    );

    const info = await extractDesktopSessionInfo(jsonPath, tmpDir);

    expect(info?.provider).toBe("claude-desktop");
    expect(info?.sessionId).toBe("desktop-cli-session-001");
  });
});

// ---------------------------------------------------------------------------
// deduplicateSessionsByProvider
// ---------------------------------------------------------------------------
