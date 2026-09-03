import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { killProcessTree, spawnTsx } from "../scripts/dev-utils.mjs";
import { generateTestReplay } from "./helpers.ts";

describe("Editor Server E2E", () => {
  let browser: Browser;
  let tmpDir: string;
  let serverPort: number;
  let serverProcess: ChildProcess;
  let slug: string;
  let sessionId: string;

  beforeAll(async () => {
    const generated = await generateTestReplay();
    tmpDir = generated.tmpDir;
    slug = generated.session.meta.slug;
    sessionId = generated.session.meta.sessionId;

    const serverModule = pathToFileURL(
      join(import.meta.dirname, "..", "packages/cli/src/server.ts"),
    ).href;
    const bootstrapPath = join(tmpDir, "start-server.mjs");
    await writeFile(
      bootstrapPath,
      [
        `import { startServer } from ${JSON.stringify(serverModule)};`,
        `await startServer(${JSON.stringify(tmpDir)}, { openDashboard: true });`,
      ].join("\n"),
      "utf-8",
    );

    serverProcess = spawnTsx([bootstrapPath], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        VIBE_REPLAY_NO_AUTO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server start timeout")), 20_000);
      const onData = (chunk: Buffer) => {
        const match = chunk.toString().match(/http:\/\/localhost:(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        serverProcess.stdout?.off("data", onData);
        resolve(Number(match[1]));
      };
      serverProcess.stdout?.on("data", onData);
      serverProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      serverProcess.once("exit", (code) => {
        if (!serverPort) {
          clearTimeout(timeout);
          reject(new Error(`server exited before binding (code ${code})`));
        }
      });
    });

    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (serverProcess) await killProcessTree(serverProcess);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("serves the generated replay through the real server route graph", async () => {
    const response = await fetch(`http://localhost:${serverPort}/api/sessions`);
    expect(response.status).toBe(200);

    const sessions = (await response.json()) as Array<{
      slug: string;
      sessionId: string;
      stats: { sceneCount: number };
    }>;
    const matchingSessions = sessions.filter((session) => session.slug === slug);
    expect(matchingSessions).toHaveLength(1);
    expect(matchingSessions[0]).toMatchObject({
      slug,
      sessionId,
      stats: { sceneCount: expect.any(Number) },
    });

    const replayResponse = await fetch(
      `http://localhost:${serverPort}/api/session?slug=${encodeURIComponent(slug)}`,
    );
    expect(replayResponse.status).toBe(200);
    const replay = (await replayResponse.json()) as {
      meta: { sessionId: string; slug: string };
      scenes: unknown[];
    };
    expect(replay.meta).toEqual(expect.objectContaining({ sessionId, slug }));
    expect(replay.scenes).toHaveLength(matchingSessions[0].stats.sceneCount);
  });

  it("registers health, auth, and viewer routes in the real server", async () => {
    const scanStatus = await fetch(`http://localhost:${serverPort}/api/scan/status`);
    expect(scanStatus.status).toBe(200);
    expect(await scanStatus.json()).toEqual(
      expect.objectContaining({ running: expect.any(Boolean), total: expect.any(Number) }),
    );

    const authStatus = await fetch(`http://localhost:${serverPort}/api/auth/status`);
    expect(authStatus.status).toBe(200);
    await expect(authStatus.json()).resolves.toEqual({ authenticated: false, user: null });

    const viewer = await fetch(`http://localhost:${serverPort}/?view=dashboard`);
    expect(viewer.status).toBe(200);
    const html = await viewer.text();
    expect(html).toContain("__VIBE_REPLAY_EDITOR__");
    expect(html).toContain("vibe-replay");
    expect(html).toContain("</html>");
  });

  it("loads the real editor shell in a browser", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://localhost:${serverPort}/?view=dashboard`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(
        () => document.body.textContent?.includes("vibe-replay") === true,
        undefined,
        { timeout: 15_000 },
      );
      expect(await page.locator("body").textContent()).toContain("vibe-replay");
    } finally {
      await page.close();
    }
  });
});
