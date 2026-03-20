/**
 * E2E tests for cloud auth + share flow.
 * Requires a valid auth.json at ~/.config/vibe-replay/auth.json
 * (created by scripts/vibe-login.mjs with a persistent browser profile).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AUTH_PATH = join(homedir(), ".config", "vibe-replay", "auth.json");

// Determine cloud API URL (same logic as CLI)
const CLOUD_API = process.env.VIBE_REPLAY_API_URL || "https://vibe-replay.com";

function loadAuth(): { token: string; user: { name: string } } | null {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    const data = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    // New per-environment format: { accounts: { origin: { token, user } } }
    if (data.accounts && typeof data.accounts === "object") {
      const origin = new URL(CLOUD_API).origin;
      const entry = data.accounts[origin];
      if (entry?.token && entry?.user) return entry;
      return null;
    }
    // Legacy flat format
    if (data.token && data.user) return data;
    return null;
  } catch {
    return null;
  }
}
const isSecure = CLOUD_API.startsWith("https://");
const cookieName = isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";

describe("cloud auth", () => {
  const auth = loadAuth();
  const skip = !auth;

  it.skipIf(skip)("auth.json exists with token and user", () => {
    expect(auth).toBeTruthy();
    expect(auth!.token).toBeTruthy();
    expect(auth!.user?.name).toBeTruthy();
  });

  it.skipIf(skip)("token is valid against cloud API with correct cookie name", async () => {
    const resp = await fetch(`${CLOUD_API}/api/auth/get-session`, {
      headers: { Cookie: `${cookieName}=${auth!.token}` },
    });
    const data = (await resp.json()) as { session?: unknown; user?: { name?: string } };
    expect(data.session).toBeTruthy();
    expect(data.user?.name).toBeTruthy();
  });

  it.skipIf(skip)("cloud-replays API works with correct cookie name", async () => {
    const resp = await fetch(`${CLOUD_API}/api/cloud-replays`, {
      headers: { Cookie: `${cookieName}=${auth!.token}` },
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { replays?: unknown[]; storage?: unknown };
    expect(data).toHaveProperty("replays");
    expect(data).toHaveProperty("storage");
  });

  it.skipIf(skip)("WRONG cookie name gets rejected (proves prefix matters)", async () => {
    const wrongName = isSecure ? "better-auth.session_token" : "__Secure-better-auth.session_token";
    const resp = await fetch(`${CLOUD_API}/api/cloud-replays`, {
      headers: { Cookie: `${wrongName}=${auth!.token}` },
    });
    // Should be 401 with wrong cookie name
    expect(resp.status).toBe(401);
  });
});

describe("editor BFF auth proxy", () => {
  const auth = loadAuth();
  const skip = !auth;

  let serverProcess: ChildProcess | null = null;
  let serverPort: number;

  beforeAll(async () => {
    if (skip) return;

    const baseDir = join(homedir(), ".vibe-replay");
    await mkdir(baseDir, { recursive: true });

    serverProcess = spawn("node", ["packages/cli/dist/index.js", "-d"], {
      env: {
        ...process.env,
        VIBE_REPLAY_NO_AUTO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Read port from server stdout (e.g. "Dashboard running at http://localhost:XXXX")
    serverPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server start timeout")), 15000);
      let output = "";
      serverProcess!.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      serverProcess!.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      serverProcess!.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}. Output: ${output}`));
      });
    });
  }, 20000);

  afterAll(() => {
    serverProcess?.kill("SIGTERM");
  });

  it.skipIf(skip)("BFF /api/auth/get-session returns session from auth.json", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/api/auth/get-session`);
    const data = (await resp.json()) as { session?: unknown; user?: { name?: string } };
    expect(data.session).toBeTruthy();
    expect(data.user?.name).toBe(auth!.user.name);
  });

  it.skipIf(skip)("BFF /api/cloud-replays proxies with correct cookie name (no 401)", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/api/cloud-replays`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { replays?: unknown[]; storage?: unknown; error?: string };
    // Must NOT be "Unauthorized" — this was the original bug
    expect(data.error).toBeUndefined();
    expect(data).toHaveProperty("replays");
    expect(data).toHaveProperty("storage");
  });

  it.skipIf(skip)("BFF /api/auth/status shows authenticated", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/api/auth/status`);
    const data = (await resp.json()) as { authenticated: boolean };
    expect(data.authenticated).toBe(true);
  });
});

describe("viewer auth consistency", () => {
  const auth = loadAuth();
  const skip = !auth;

  let serverProcess: ChildProcess | null = null;
  let serverPort: number;
  let browser: Browser;

  beforeAll(async () => {
    if (skip) return;

    const baseDir = join(homedir(), ".vibe-replay");
    await mkdir(baseDir, { recursive: true });

    serverProcess = spawn("node", ["packages/cli/dist/index.js", "-d"], {
      env: {
        ...process.env,
        VIBE_REPLAY_NO_AUTO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server start timeout")), 15000);
      let output = "";
      serverProcess!.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      serverProcess!.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      serverProcess!.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}. Output: ${output}`));
      });
    });

    browser = await chromium.launch();
  }, 20000);

  afterAll(async () => {
    await browser?.close();
    serverProcess?.kill("SIGTERM");
  });

  it.skipIf(skip)("header and share section both show logged-in state", async () => {
    // Get list of existing replays to find a session to test with
    const sessionsResp = await fetch(`http://localhost:${serverPort}/api/sessions`);
    const sessions = (await sessionsResp.json()) as { slug: string }[];

    if (sessions.length === 0) {
      // No sessions to test viewer — just verify API consistency
      return;
    }

    const page = await browser.newPage();
    const slug = sessions[0].slug;
    await page.goto(`http://localhost:${serverPort}/?session=${slug}`, {
      waitUntil: "networkidle",
    });

    // Wait for auth checks
    await page.waitForTimeout(3000);

    // Click SHARE & EXPORT tab if visible
    const shareTab = page.locator("button", { hasText: /share/i }).first();
    if (await shareTab.isVisible().catch(() => false)) {
      await shareTab.click();
      await page.waitForTimeout(2000);
    }

    // Header should NOT show "Sign in" button (user is logged in)
    const headerSignInBtn = page.locator("header button", { hasText: "Sign in" });
    const headerShowsSignIn = await headerSignInBtn.isVisible().catch(() => false);

    // Share section should NOT show "Sign in with GitHub" CTA
    const shareSignInCta = page.locator("button", { hasText: "Sign in with GitHub" });
    const shareShowsCta = await shareSignInCta.isVisible().catch(() => false);

    // CONSISTENCY: both must agree
    expect(headerShowsSignIn).toBe(shareShowsCta);

    // Since we have valid auth, neither should show sign-in
    expect(headerShowsSignIn).toBe(false);
    expect(shareShowsCta).toBe(false);

    await page.close();
  });
});
