import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_PREVIEW_HINT,
  ShareError,
  describeLocalShareFallback,
  ensureLocalReplayHtml,
  printLocalShareFallback,
  requireReplayDir,
  shareReplay,
} from "../src/share.js";

function writeReplayDir(root: string, slug = "demo"): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "replay.json"),
    JSON.stringify({
      meta: { title: "Demo", slug, sessionId: "s1", provider: "claude-code" },
      scenes: [],
    }),
  );
  writeFileSync(join(dir, "index.html"), "<html>local replay</html>");
  return dir;
}

describe("share local HTML fallback", () => {
  let root: string;
  const originalNoAutoOpen = process.env.VIBE_REPLAY_NO_AUTO_OPEN;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vibe-share-fallback-"));
    delete process.env.VIBE_REPLAY_NO_AUTO_OPEN;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalNoAutoOpen === undefined) delete process.env.VIBE_REPLAY_NO_AUTO_OPEN;
    else process.env.VIBE_REPLAY_NO_AUTO_OPEN = originalNoAutoOpen;
  });

  describe("requireReplayDir", () => {
    it("resolves a replay directory", () => {
      const dir = writeReplayDir(root);
      expect(requireReplayDir(dir)).toBe(dir);
    });

    it("resolves a path to replay.json", () => {
      const dir = writeReplayDir(root);
      expect(requireReplayDir(join(dir, "replay.json"))).toBe(dir);
    });

    it("throws when the path is missing", () => {
      expect(() => requireReplayDir(join(root, "missing"))).toThrow(ShareError);
      expect(() => requireReplayDir(join(root, "missing"))).toThrow(/Path not found/);
    });

    it("throws when replay.json is missing", () => {
      const dir = join(root, "empty");
      mkdirSync(dir);
      expect(() => requireReplayDir(dir)).toThrow(/No replay.json found/);
    });
  });

  describe("ensureLocalReplayHtml", () => {
    it("returns existing index.html without regenerating", async () => {
      const dir = writeReplayDir(root);
      const htmlPath = await ensureLocalReplayHtml(dir);
      expect(htmlPath).toBe(join(dir, "index.html"));
    });

    const viewerHtmlPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "assets",
      "viewer.html",
    );

    it.skipIf(!existsSync(viewerHtmlPath))(
      "writes index.html from replay.json when the HTML is missing",
      async () => {
        const dir = writeReplayDir(root);
        rmSync(join(dir, "index.html"));
        const htmlPath = await ensureLocalReplayHtml(dir);
        expect(htmlPath).toBe(join(dir, "index.html"));
        const html = await readFile(htmlPath, "utf-8");
        expect(html).toContain("<html");
      },
    );

    it("shareReplay regenerates HTML through ensureHtml when index.html is missing", async () => {
      const dir = writeReplayDir(root);
      rmSync(join(dir, "index.html"));
      const ensureHtml = vi.fn(async (outputDir: string) => {
        const htmlPath = join(outputDir, "index.html");
        writeFileSync(htmlPath, "<html>generated</html>");
        return htmlPath;
      });
      const result = await shareReplay(dir, {
        loggedIn: false,
        ensureHtml,
        openHtml: async () => true,
      });
      expect(ensureHtml).toHaveBeenCalledWith(dir);
      expect(result.mode).toBe("local-fallback");
      if (result.mode !== "local-fallback") throw new Error("expected local fallback");
      expect(result.htmlPath).toBe(join(dir, "index.html"));
    });
  });

  describe("shareReplay", () => {
    it("opens local HTML and does not upload when not logged in", async () => {
      const dir = writeReplayDir(root);
      const openHtml = vi.fn(async () => true);
      const publishCloud = vi.fn();

      const result = await shareReplay(dir, { loggedIn: false, openHtml, publishCloud });

      expect(result.mode).toBe("local-fallback");
      if (result.mode !== "local-fallback") throw new Error("expected local fallback");
      expect(result.htmlPath).toBe(join(dir, "index.html"));
      expect(result.fileUrl).toBe(pathToFileURL(result.htmlPath).href);
      expect(result.fileUrl).toMatch(/^file:/);
      expect(result.opened).toBe(true);
      expect(openHtml).toHaveBeenCalledWith(result.htmlPath);
      expect(publishCloud).not.toHaveBeenCalled();
    });

    it("skips the browser opener when VIBE_REPLAY_NO_AUTO_OPEN=1", async () => {
      process.env.VIBE_REPLAY_NO_AUTO_OPEN = "1";
      const dir = writeReplayDir(root);
      const openHtml = vi.fn(async () => true);

      const result = await shareReplay(dir, { loggedIn: false, openHtml });

      expect(result.mode).toBe("local-fallback");
      if (result.mode !== "local-fallback") throw new Error("expected local fallback");
      expect(result.opened).toBe(false);
      expect(openHtml).not.toHaveBeenCalled();
    });

    it("uploads to cloud when logged in", async () => {
      const dir = writeReplayDir(root);
      const openHtml = vi.fn(async () => true);
      const publishCloud = vi.fn(async () => ({
        url: "https://vibe-replay.com/r/abc",
        expiresAt: "2026-09-17T00:00:00.000Z",
      }));

      const result = await shareReplay(dir, {
        loggedIn: true,
        visibility: "unlisted",
        openHtml,
        publishCloud,
      });

      expect(result).toEqual({
        mode: "cloud",
        url: "https://vibe-replay.com/r/abc",
        expiresAt: "2026-09-17T00:00:00.000Z",
      });
      expect(publishCloud).toHaveBeenCalledWith(dir, { visibility: "unlisted" });
      expect(openHtml).not.toHaveBeenCalled();
    });

    it("throws when the replay directory has no replay.json", async () => {
      const dir = join(root, "empty");
      mkdirSync(dir);
      await expect(
        shareReplay(dir, { loggedIn: false, openHtml: async () => true }),
      ).rejects.toThrow(/No replay.json found/);
    });
  });

  describe("fallback copy", () => {
    it("points at the HTML file, a file:// URL, and auth login", () => {
      const htmlPath = join(root, "index.html");
      const copy = describeLocalShareFallback(htmlPath, false);
      expect(copy.htmlPath).toBe(htmlPath);
      expect(copy.fileUrl).toBe(pathToFileURL(htmlPath).href);
      expect(LOCAL_PREVIEW_HINT).toBe("vibe-replay --session <path> --open");
    });

    it("prints local artifact paths instead of a login dead-end", () => {
      const htmlPath = join(root, "demo", "index.html");
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      printLocalShareFallback(describeLocalShareFallback(htmlPath, false));
      spy.mockRestore();

      const output = stripVTControlCharacters(lines.join("\n"));
      expect(output).toContain("Cloud share skipped (not logged in).");
      expect(output).toContain("Local HTML is ready");
      expect(output).toContain(htmlPath);
      expect(output).toContain(pathToFileURL(htmlPath).href);
      expect(output).toContain("send this HTML file to anyone");
      expect(output).toContain("vibe-replay auth login");
      expect(output).not.toMatch(/✗ Not logged in/);
    });
  });
});
