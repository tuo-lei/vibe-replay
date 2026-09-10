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
import type { ReplaySession } from "../src/types.js";

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

function writeSshReplayDir(root: string, slug = "demo"): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "replay.json"),
    JSON.stringify({
      meta: {
        title: "Demo",
        slug,
        sessionId: "s1",
        provider: "codex",
        location: { kind: "ssh", id: "remote-dev", label: "Remote dev" },
        gitRepo: "private-org/private-repo",
        startTime: "2026-08-25T00:00:00.000Z",
        cwd: "~/project",
        project: "~/project",
        stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
      },
      scenes: [{ type: "user-prompt", content: "original prompt" }],
    }),
  );
  writeFileSync(join(dir, "index.html"), "<html>stale gitRepo private-org/private-repo</html>");
  writeFileSync(
    join(dir, "overlays.json"),
    JSON.stringify({
      version: 1,
      overlays: [
        {
          id: "ov-1",
          sceneIndex: 0,
          field: "content",
          originalValue: "original prompt",
          modifiedValue: "edited prompt",
          source: { type: "manual" },
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "annotations.json"),
    JSON.stringify([
      {
        id: "ann-1",
        sceneIndex: 0,
        body: "review note",
        author: "me",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
        resolved: false,
      },
    ]),
  );
  return dir;
}

async function fakeGenerate(session: ReplaySession, outputDir: string): Promise<string> {
  const htmlPath = join(outputDir, "index.html");
  writeFileSync(htmlPath, JSON.stringify(session));
  writeFileSync(join(outputDir, "replay.json"), JSON.stringify(session));
  return htmlPath;
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
    it("rebuilds HTML instead of returning a stale index.html", async () => {
      const dir = writeSshReplayDir(root);
      const generate = vi.fn(fakeGenerate);

      const htmlPath = await ensureLocalReplayHtml(dir, generate);

      expect(generate).toHaveBeenCalledTimes(1);
      expect(htmlPath).toBe(join(dir, "index.html"));
      const html = await readFile(htmlPath, "utf-8");
      expect(html).not.toContain("stale gitRepo");
    });

    it("strips SSH gitRepo from the shareable HTML and restores local replay.json", async () => {
      const dir = writeSshReplayDir(root);
      await ensureLocalReplayHtml(dir, fakeGenerate);

      const html = await readFile(join(dir, "index.html"), "utf-8");
      expect(html).not.toContain("private-org/private-repo");
      const shared = JSON.parse(html) as ReplaySession;
      expect(shared.meta.gitRepo).toBeUndefined();
      expect(shared.meta.location).toEqual({
        kind: "ssh",
        id: "remote-dev",
        label: "Remote dev",
      });

      const local = JSON.parse(await readFile(join(dir, "replay.json"), "utf-8")) as ReplaySession;
      expect(local.meta.gitRepo).toBe("private-org/private-repo");
      expect(local.scenes[0]).toMatchObject({ type: "user-prompt", content: "original prompt" });
    });

    it("applies overlays and annotations before generating fallback HTML", async () => {
      const dir = writeSshReplayDir(root);
      await ensureLocalReplayHtml(dir, fakeGenerate);

      const html = await readFile(join(dir, "index.html"), "utf-8");
      const shared = JSON.parse(html) as ReplaySession;
      expect(shared.scenes[0]).toMatchObject({ type: "user-prompt", content: "edited prompt" });
      expect(shared.annotations).toEqual([
        expect.objectContaining({ id: "ann-1", body: "review note" }),
      ]);
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
  });

  describe("shareReplay", () => {
    it("opens local HTML and does not upload when not logged in", async () => {
      const dir = writeReplayDir(root);
      const openHtml = vi.fn(async () => true);
      const publishCloud = vi.fn();
      const generateHtml = vi.fn(fakeGenerate);

      const result = await shareReplay(dir, {
        loggedIn: false,
        openHtml,
        publishCloud,
        generateHtml,
      });

      expect(result.mode).toBe("local-fallback");
      if (result.mode !== "local-fallback") throw new Error("expected local fallback");
      expect(result.htmlPath).toBe(join(dir, "index.html"));
      expect(result.fileUrl).toBe(pathToFileURL(result.htmlPath).href);
      expect(result.fileUrl).toMatch(/^file:/);
      expect(result.opened).toBe(true);
      expect(openHtml).toHaveBeenCalledWith(result.htmlPath);
      expect(publishCloud).not.toHaveBeenCalled();
      expect(generateHtml).toHaveBeenCalled();
    });

    it("sanitizes SSH identity on the no-auth share path", async () => {
      const dir = writeSshReplayDir(root);
      const result = await shareReplay(dir, {
        loggedIn: false,
        openHtml: async () => true,
        publishCloud: vi.fn(),
        generateHtml: fakeGenerate,
      });

      expect(result.mode).toBe("local-fallback");
      const html = await readFile(join(dir, "index.html"), "utf-8");
      expect(html).not.toContain("private-org/private-repo");
      expect(html).toContain("edited prompt");
      const local = JSON.parse(await readFile(join(dir, "replay.json"), "utf-8")) as ReplaySession;
      expect(local.meta.gitRepo).toBe("private-org/private-repo");
    });

    it("skips the browser opener when VIBE_REPLAY_NO_AUTO_OPEN=1", async () => {
      process.env.VIBE_REPLAY_NO_AUTO_OPEN = "1";
      const dir = writeReplayDir(root);
      const openHtml = vi.fn(async () => true);

      const result = await shareReplay(dir, {
        loggedIn: false,
        openHtml,
        generateHtml: fakeGenerate,
      });

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
