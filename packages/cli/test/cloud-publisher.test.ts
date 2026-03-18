import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir before importing the module
const mockAuthDir = join(tmpdir(), `vibe-replay-cloud-test-${Date.now()}`);
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => mockAuthDir };
});

const { loadAuthToken, loadSavedCloudInfo } = await import("../src/publishers/cloud.js");

describe("cloud publisher", () => {
  beforeEach(() => {
    mkdirSync(join(mockAuthDir, ".config", "vibe-replay"), { recursive: true });
  });

  afterEach(() => {
    rmSync(mockAuthDir, { recursive: true, force: true });
  });

  describe("loadAuthToken", () => {
    it("returns auth data when valid auth.json exists", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          token: "session-token-123",
          user: { id: "u1", name: "Test User", email: "test@example.com" },
        }),
      );
      const auth = loadAuthToken();
      expect(auth).toBeDefined();
      expect(auth?.token).toBe("session-token-123");
      expect(auth?.user.name).toBe("Test User");
    });

    it("returns null when auth.json is missing", () => {
      const auth = loadAuthToken();
      expect(auth).toBeNull();
    });

    it("returns null when auth.json has no token", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(authPath, JSON.stringify({ user: { id: "u1" } }));
      const auth = loadAuthToken();
      expect(auth).toBeNull();
    });

    it("returns null when auth.json has no user", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(authPath, JSON.stringify({ token: "abc" }));
      const auth = loadAuthToken();
      expect(auth).toBeNull();
    });
  });

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
});
