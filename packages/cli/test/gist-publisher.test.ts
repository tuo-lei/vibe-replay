import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir before importing the module
const mockAuthDir = join(tmpdir(), `vibe-replay-test-${Date.now()}`);
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => mockAuthDir };
});

const { checkPublishStatus, loadSavedGistInfo } = await import("../src/publishers/gist.js");

describe("gist publisher", () => {
  beforeEach(() => {
    mkdirSync(join(mockAuthDir, ".config", "vibe-replay"), { recursive: true });
  });

  afterEach(() => {
    rmSync(mockAuthDir, { recursive: true, force: true });
  });

  describe("checkPublishStatus", () => {
    it("returns available when auth.json exists with valid token", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          token: "test-token",
          user: { id: "u1", name: "Test" },
        }),
      );
      const status = checkPublishStatus();
      expect(status.available).toBe(true);
    });

    it("returns unavailable when auth.json is missing", () => {
      // Don't create auth.json
      const status = checkPublishStatus();
      expect(status.available).toBe(false);
    });

    it("returns unavailable when auth.json has no token", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(authPath, JSON.stringify({ user: { id: "u1" } }));
      const status = checkPublishStatus();
      expect(status.available).toBe(false);
    });

    it("returns unavailable when auth.json is malformed", () => {
      const authPath = join(mockAuthDir, ".config", "vibe-replay", "auth.json");
      writeFileSync(authPath, "not json");
      const status = checkPublishStatus();
      expect(status.available).toBe(false);
    });
  });

  describe("loadSavedGistInfo", () => {
    it("returns undefined when no gist meta file exists", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      const info = await loadSavedGistInfo(dir);
      expect(info).toBeUndefined();
    });

    it("returns gist info when meta file exists", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".vibe-replay-gist.json"),
        JSON.stringify({
          gistId: "abc123def456abc123def456",
          filename: "test.json",
          gistUrl: "https://gist.github.com/abc123",
          viewerUrl: "https://vibe-replay.com/view/?gist=abc123",
          updatedAt: "2025-01-01T00:00:00Z",
          contentHash: "abcdef1234567890",
        }),
      );
      const info = await loadSavedGistInfo(dir);
      expect(info).toBeDefined();
      expect(info?.gistId).toBe("abc123def456abc123def456");
      expect(info?.filename).toBe("test.json");
    });

    it("returns undefined for malformed meta file", async () => {
      const dir = join(mockAuthDir, "replay-test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".vibe-replay-gist.json"), "{}");
      const info = await loadSavedGistInfo(dir);
      expect(info).toBeUndefined();
    });
  });
});
