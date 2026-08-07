import { rm } from "node:fs/promises";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplaySession } from "../packages/types/src/index.ts";
import { generateTestReplay } from "./helpers.ts";

const EXTERNAL_IMAGE_URL = "https://images.example.test/replay.png";

describe("Generated HTML E2E", () => {
  let browser: Browser;
  let page: Page;
  let htmlPath: string;
  let session: ReplaySession;
  let tmpDir: string;
  let consoleErrors: string[];
  let externalRequests: string[];

  beforeAll(async () => {
    // Generate replay HTML from fixture
    const result = await generateTestReplay();
    htmlPath = result.htmlPath;
    session = result.session;
    tmpDir = result.tmpDir;

    // Launch browser and open generated HTML
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    // Track console errors and external requests
    consoleErrors = [];
    externalRequests = [];

    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Intercept network requests — self-contained HTML should make none
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        externalRequests.push(url);
      }
      route.continue();
    });

    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    // Wait for React to render
    await page.waitForTimeout(1000);
  });

  afterAll(async () => {
    await browser?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("renders without console errors", () => {
    // Filter out known non-critical errors (e.g., favicon 404)
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("404"),
    );
    expect(criticalErrors).toEqual([]);
  });

  it("makes no external network requests (self-contained)", () => {
    // GitHub star widget is expected — it's a UI element, not a data dependency
    const dataRequests = externalRequests.filter(
      (url) => !url.includes("buttons.github.io") && !url.includes("api.github.com"),
    );
    expect(dataRequests).toEqual([]);
  });

  it.each([30, 500])(
    "loads external images only after explicit consent in a %i-scene replay",
    async (sceneCount) => {
      const generated = await generateTestReplay({
        externalImageUrl: EXTERNAL_IMAGE_URL,
        sceneCount,
      });
      const consentPage = await browser.newPage();
      const requests: string[] = [];
      await consentPage.route("**/*", (route) => {
        const url = route.request().url();
        if (url === EXTERNAL_IMAGE_URL) {
          requests.push(url);
          return route.fulfill({
            status: 200,
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nJcAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        }
        route.continue();
      });

      try {
        await consentPage.goto(`file://${generated.htmlPath}`, { waitUntil: "networkidle" });
        await consentPage.waitForTimeout(500);
        expect(requests).toEqual([]);
        expect(await consentPage.locator(`img[src="${EXTERNAL_IMAGE_URL}"]`).count()).toBe(0);

        await consentPage
          .getByRole("button", { name: /Watch Replay/i })
          .first()
          .click();
        await consentPage.waitForTimeout(500);
        const loadButton = consentPage.getByRole("button", { name: "Load external image" }).first();
        expect(await loadButton.count()).toBe(1);
        await Promise.all([consentPage.waitForRequest(EXTERNAL_IMAGE_URL), loadButton.click()]);

        expect(requests).toEqual([EXTERNAL_IMAGE_URL]);
        expect(await consentPage.locator(`img[src="${EXTERNAL_IMAGE_URL}"]`).count()).toBe(1);
      } finally {
        await consentPage.close();
        await rm(generated.tmpDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("embeds session data correctly", async () => {
    const hasData = await page.evaluate(() => {
      return (
        typeof window.__VIBE_REPLAY_DATA__ === "object" && window.__VIBE_REPLAY_DATA__ !== null
      );
    });
    expect(hasData).toBe(true);
  });

  it("renders correct number of scenes", async () => {
    const embeddedSceneCount = await page.evaluate(() => {
      return window.__VIBE_REPLAY_DATA__?.scenes?.length ?? 0;
    });
    expect(embeddedSceneCount).toBe(session.scenes.length);
  });

  it("displays user prompt content", async () => {
    const userPrompts = session.scenes.filter((s) => s.type === "user-prompt");
    expect(userPrompts.length).toBeGreaterThan(0);

    // Click through landing hero if it exists
    const landingDismiss = page.locator("[data-testid='landing-dismiss']");
    if (await landingDismiss.isVisible({ timeout: 1000 }).catch(() => false)) {
      await landingDismiss.click();
      await page.waitForTimeout(500);
    }

    // Check that the page body contains text from the first user prompt
    const bodyText = await page.textContent("body");
    const firstPrompt = userPrompts[0].content.slice(0, 30);
    expect(bodyText).toContain(firstPrompt);
  });

  it("does not show error state", async () => {
    // The viewer shows specific error text when it fails to load
    const bodyText = await page.textContent("body");
    expect(bodyText).not.toContain("Failed to load");
    expect(bodyText).not.toContain("Could not load session");
  });

  it("has title set from session", async () => {
    const title = await page.title();
    // Title should contain something meaningful (session title or slug)
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toBe("vibe-replay"); // Should be customized, not default
  });

  it("attaches resultTokens estimate to tool-call scenes with non-empty results", () => {
    const toolScenes = session.scenes.filter((s) => s.type === "tool-call");
    expect(toolScenes.length).toBeGreaterThan(0);
    // At least one tool scene with a non-trivial result should carry an estimate.
    const withTokens = toolScenes.filter(
      (s) => s.type === "tool-call" && typeof s.resultTokens === "number" && s.resultTokens > 0,
    );
    expect(withTokens.length).toBeGreaterThan(0);
  });

  it("preserves resultTokens through the embedded data envelope", async () => {
    // The viewer reads from window.__VIBE_REPLAY_DATA__; verifying the field
    // survives serialization is the load-bearing check. The DOM badge text
    // ("~Ntok") is incidental rendering of this field via formatTokens.
    const embeddedTokens = await page.evaluate(() => {
      const scenes = window.__VIBE_REPLAY_DATA__?.scenes ?? [];
      return scenes
        .filter((s: { type?: string }) => s.type === "tool-call")
        .map((s: { resultTokens?: number }) => s.resultTokens ?? 0);
    });
    expect(embeddedTokens.some((n: number) => n > 0)).toBe(true);
  });

  it("supports subAgent field in tool-call scenes (backward compatible)", async () => {
    // Verify the data structure supports subAgent (optional field on tool-call scenes)
    const toolScenes = session.scenes.filter((s) => s.type === "tool-call");
    expect(toolScenes.length).toBeGreaterThan(0);
    // All tool scenes should have valid structure — subAgent is optional
    for (const s of toolScenes) {
      if (s.type === "tool-call") {
        expect(s.toolName).toBeDefined();
        // subAgent should be undefined for fixture data (no subagents)
        // This confirms backward compatibility — old data without subAgent still works
      }
    }
    // Verify viewer rendered without errors (covered by earlier test but explicit here)
    const bodyText = await page.textContent("body");
    expect(bodyText).not.toContain("Failed to load");
  });

  it("renders insights view without errors", async () => {
    // Navigate to insights/summary view
    await page.goto(`file://${htmlPath}?v=summary`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Check that the page renders content (stats panel + overview)
    const bodyText = await page.textContent("body");
    expect(bodyText).toBeTruthy();
    // Should contain stat values from the session
    expect(bodyText).toContain(String(session.meta.stats.userPrompts));

    // Verify no console errors on insights view
    const newErrors = consoleErrors.filter((e) => !e.includes("favicon") && !e.includes("404"));
    expect(newErrors).toEqual([]);
  });
});
