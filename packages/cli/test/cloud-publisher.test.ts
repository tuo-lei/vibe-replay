import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir before importing the module
const mockAuthDir = join(tmpdir(), `vibe-replay-cloud-test-${Date.now()}`);
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => mockAuthDir };
});

const {
  isAllowedApiUrl,
  loadAuthToken,
  loadSavedCloudInfo,
  publishCloudWithOverlays,
  saveAuthTokenSync,
} = await import("../src/publishers/cloud.js");

describe("cloud publisher", () => {
  beforeEach(() => {
    mkdirSync(join(mockAuthDir, ".config", "vibe-replay"), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(mockAuthDir, { recursive: true, force: true });
  });

  describe("loadAuthToken", () => {
    it("returns auth data when valid auth.json exists (new format)", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          accounts: {
            "https://vibe-replay.com": {
              token: "session-token-123",
              user: { id: "u1", name: "Test User", email: "test@example.com" },
            },
          },
        }),
      );
      const auth = loadAuthToken("https://vibe-replay.com");
      expect(auth).toBeDefined();
      expect(auth?.token).toBe("session-token-123");
      expect(auth?.user.name).toBe("Test User");
    });

    it("migrates legacy flat format under default production origin", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          token: "legacy-token",
          user: { id: "u1", name: "Legacy User", email: "legacy@example.com" },
        }),
      );
      // Legacy format should be accessible under the default production URL
      const auth = loadAuthToken("https://vibe-replay.com");
      expect(auth).toBeDefined();
      expect(auth?.token).toBe("legacy-token");
      expect(auth?.user.name).toBe("Legacy User");
    });

    it("returns null for non-matching environment", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          accounts: {
            "https://vibe-replay.com": {
              token: "prod-token",
              user: { id: "u1", name: "Prod User" },
            },
          },
        }),
      );
      // Requesting local dev token should return null
      const auth = loadAuthToken("http://localhost:8787");
      expect(auth).toBeNull();
    });

    it("supports multiple environments", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          accounts: {
            "https://vibe-replay.com": {
              token: "prod-token",
              user: { id: "u1", name: "Prod User" },
            },
            "http://localhost:8787": {
              token: "dev-token",
              user: { id: "u2", name: "Dev User" },
            },
          },
        }),
      );
      const prod = loadAuthToken("https://vibe-replay.com");
      expect(prod?.token).toBe("prod-token");
      const dev = loadAuthToken("http://localhost:8787");
      expect(dev?.token).toBe("dev-token");
    });

    it("returns null when auth.json is missing", () => {
      const auth = loadAuthToken();
      expect(auth).toBeNull();
    });

    it("returns null when account has no token", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          accounts: { "https://vibe-replay.com": { user: { id: "u1" } } },
        }),
      );
      const auth = loadAuthToken("https://vibe-replay.com");
      expect(auth).toBeNull();
    });

    it("returns null when account has no user", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          accounts: { "https://vibe-replay.com": { token: "abc" } },
        }),
      );
      const auth = loadAuthToken("https://vibe-replay.com");
      expect(auth).toBeNull();
    });
  });

  it("requires HTTPS for production auth while allowing loopback development", () => {
    expect(isAllowedApiUrl("https://vibe-replay.com")).toBe(true);
    expect(isAllowedApiUrl("http://vibe-replay.com")).toBe(false);
    expect(isAllowedApiUrl("http://localhost:8787")).toBe(true);
    expect(isAllowedApiUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isAllowedApiUrl("https://vibe-replay.com.evil.example")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "tightens permissions on an existing auth file and directory",
    () => {
      const authDir = join(mockAuthDir, ".config", "vibe-replay");
      const authPath = join(authDir, "auth.json");
      chmodSync(authDir, 0o755);
      writeFileSync(authPath, "{}", { mode: 0o644 });

      saveAuthTokenSync({
        token: "session-token",
        user: { id: "u1", name: "Test User" },
      });

      expect(statSync(authDir).mode & 0o777).toBe(0o700);
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
    },
  );

  describe("loadSavedCloudInfo", () => {
    it("returns undefined when no cloud meta file exists", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      const info = await loadSavedCloudInfo(dir);
      expect(info).toBeUndefined();
    });

    it("returns cloud info when meta file exists", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".vibe-replay-cloud.json"),
        JSON.stringify({
          id: "abc123xyz789",
          url: "https://vibe-replay.com/r/abc123xyz789",
          expiresAt: "2025-04-01 00:00:00",
          updatedAt: "2025-03-25T00:00:00Z",
        }),
      );
      const info = await loadSavedCloudInfo(dir);
      expect(info).toBeDefined();
      expect(info?.id).toBe("abc123xyz789");
      expect(info?.url).toContain("/r/abc123xyz789");
    });

    it("returns undefined for incomplete meta file", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".vibe-replay-cloud.json"), JSON.stringify({ id: "x" }));
      const info = await loadSavedCloudInfo(dir);
      expect(info).toBeUndefined();
    });
  });

  it("strips SSH repository metadata even when no overlays exist", async () => {
    const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        accounts: {
          "https://vibe-replay.com": {
            token: "session-token",
            user: { id: "u1", name: "Test User" },
          },
        },
      }),
    );
    const outputDir = join(mockAuthDir, "remote-replay");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "replay.json"),
      JSON.stringify({
        meta: {
          sessionId: "session",
          slug: "session",
          provider: "codex",
          location: { kind: "ssh", id: "remote-dev", label: "Remote dev" },
          gitRepo: "private-org/private-repo",
          startTime: "2026-08-25T00:00:00.000Z",
          cwd: "~/project",
          project: "~/project",
          stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
        },
        scenes: [{ type: "user-prompt", content: "Inspect the project" }],
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "cloud-id",
        url: "https://vibe-replay.com/r/cloud-id",
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await publishCloudWithOverlays(outputDir);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.replay.meta.gitRepo).toBeUndefined();
    expect(JSON.parse(readFileSync(join(outputDir, "replay.json"), "utf-8")).meta.gitRepo).toBe(
      "private-org/private-repo",
    );
  });
});
