import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTestReplay } from "./helpers.ts";

describe("Editor Server E2E", () => {
  let browser: Browser;
  let tmpDir: string;
  let serverPort: number;
  let server: ReturnType<typeof serve>;
  let viewerHtml: string;

  beforeAll(async () => {
    // Generate a replay to disk
    const result = await generateTestReplay();
    tmpDir = result.tmpDir;

    // Load viewer HTML
    viewerHtml = await readFile(
      join(import.meta.dirname, "..", "packages/cli/assets/viewer.html"),
      "utf-8",
    );

    // Build a minimal Hono app that mirrors the real server's key routes
    const app = new Hono();

    app.get("/", (c) => {
      const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
      const headIdx = viewerHtml.lastIndexOf("</head>");
      const html = `${viewerHtml.slice(0, headIdx) + flag}\n${viewerHtml.slice(headIdx)}`;
      return c.html(html);
    });

    app.get("/api/sessions", async (c) => {
      const { readdir } = await import("node:fs/promises");
      const results: { slug: string; title?: string; provider?: string }[] = [];
      try {
        const entries = await readdir(tmpDir);
        for (const entry of entries) {
          try {
            const raw = await readFile(join(tmpDir, entry, "replay.json"), "utf-8");
            const session = JSON.parse(raw);
            results.push({
              slug: entry,
              title: session.meta?.title,
              provider: session.meta?.provider,
            });
          } catch {
            /* not a session dir */
          }
        }
      } catch {
        /* empty */
      }
      return c.json(results);
    });

    app.get("/api/session", async (c) => {
      const slug = c.req.query("slug");
      if (!slug) return c.json({ error: "slug required" }, 400);
      try {
        const raw = await readFile(join(tmpDir, slug, "replay.json"), "utf-8");
        return c.json(JSON.parse(raw));
      } catch {
        return c.json({ error: "not found" }, 404);
      }
    });

    // Start server on random port
    serverPort = 19876 + Math.floor(Math.random() * 1000);
    server = serve({ fetch: app.fetch, port: serverPort, hostname: "127.0.0.1" });

    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/sessions returns session list", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/api/sessions`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { slug: string }[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("slug");
  });

  it("GET /api/session?slug returns session data", async () => {
    const listResp = await fetch(`http://localhost:${serverPort}/api/sessions`);
    const sessions = (await listResp.json()) as { slug: string }[];
    const testSlug = sessions[0].slug;

    const resp = await fetch(`http://localhost:${serverPort}/api/session?slug=${testSlug}`);
    expect(resp.status).toBe(200);
    const session = (await resp.json()) as { meta: { sessionId: string }; scenes: unknown[] };
    expect(session).toHaveProperty("meta");
    expect(session.meta).toHaveProperty("sessionId");
    expect(session).toHaveProperty("scenes");
    expect(Array.isArray(session.scenes)).toBe(true);
  });

  it("GET / serves viewer HTML with editor flag", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("__VIBE_REPLAY_EDITOR__");
    expect(html).toContain("</html>");
  });

  it("viewer loads in browser from server", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${serverPort}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Verify the viewer loaded (not a blank page or server error)
    const html = await page.content();
    expect(html).toContain("vibe-replay");
    expect(html).toContain("__VIBE_REPLAY_EDITOR__");

    await page.close();
  });
});
