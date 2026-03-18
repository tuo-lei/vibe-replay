import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Auth integration tests against wrangler dev.
 *
 * These verify that the Worker's auth endpoints respond correctly
 * without hitting GitHub OAuth. They catch:
 * - Drizzle schema / D1 mismatches
 * - Better Auth adapter misconfiguration
 * - CORS / routing regressions
 * - Input validation (callbackURL, port, nonce)
 *
 * Requires cloudflare/.dev.vars with GitHub OAuth credentials.
 * Skipped in CI where .dev.vars is not available.
 */

const HAS_DEV_VARS = existsSync("cloudflare/.dev.vars");
const describeAuth = HAS_DEV_VARS ? describe : describe.skip;

const WORKER_URL = "http://localhost:8787";
let wranglerProcess: ReturnType<typeof import("node:child_process").spawn>;

async function waitForWorker(url: string, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${url}/api/replays`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Worker not ready after ${timeout}ms`);
}

describeAuth("Auth Worker E2E", () => {
  beforeAll(async () => {
    // Ensure local D1 has the schema (uses Drizzle-managed migrations)
    execSync("pnpm db:migrate:local", {
      cwd: "cloudflare",
      stdio: "pipe",
    });

    // Start wrangler dev in background
    const { spawn } = await import("node:child_process");
    wranglerProcess = spawn("pnpm", ["wrangler", "dev", "--port", "8787"], {
      cwd: "cloudflare",
      stdio: "pipe",
      detached: false,
    });

    await waitForWorker(WORKER_URL);
  }, 20_000);

  afterAll(() => {
    wranglerProcess?.kill();
  });

  // -----------------------------------------------------------------------
  // Existing API not broken
  // -----------------------------------------------------------------------

  it("GET /api/replays still works", async () => {
    const res = await fetch(`${WORKER_URL}/api/replays`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Auth session endpoint
  // -----------------------------------------------------------------------

  it("GET /api/auth/get-session returns empty when not logged in", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/get-session`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    // Better Auth returns null body or object without session when not logged in
    expect(data?.session?.token).toBeFalsy();
  });

  // -----------------------------------------------------------------------
  // Sign-in endpoint
  // -----------------------------------------------------------------------

  it("POST /api/auth/sign-in/social returns GitHub OAuth URL", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WORKER_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.url).toContain("github.com/login/oauth/authorize");
    expect(data.url).toContain("client_id=");
    expect(data.url).toContain("code_challenge=");
  });

  // -----------------------------------------------------------------------
  // callbackURL validation
  // -----------------------------------------------------------------------

  it("rejects absolute callbackURL", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WORKER_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "https://evil.com" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toContain("Invalid callbackURL");
  });

  it("rejects protocol-relative callbackURL", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WORKER_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "//evil.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts relative callbackURL", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WORKER_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
    });
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // CLI login endpoint validation
  // -----------------------------------------------------------------------

  it("cli-login rejects missing port", async () => {
    const res = await fetch(`${WORKER_URL}/auth/cli-login`);
    expect(res.status).toBe(400);
  });

  it("cli-login rejects non-numeric port", async () => {
    const res = await fetch(
      `${WORKER_URL}/auth/cli-login?port=abc&nonce=00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(400);
  });

  it("cli-login rejects port below 1024", async () => {
    const res = await fetch(
      `${WORKER_URL}/auth/cli-login?port=80&nonce=00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(400);
  });

  it("cli-login rejects missing nonce", async () => {
    const res = await fetch(`${WORKER_URL}/auth/cli-login?port=3000`);
    expect(res.status).toBe(400);
  });

  it("cli-login accepts valid port and nonce", async () => {
    const res = await fetch(
      `${WORKER_URL}/auth/cli-login?port=3000&nonce=a1b2c3d4-e5f6-7890-abcd-ef1234567890`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Redirecting to GitHub");
  });

  // -----------------------------------------------------------------------
  // Sign-out endpoint
  // -----------------------------------------------------------------------

  it("POST /api/auth/sign-out clears cookies", async () => {
    const res = await fetch(`${WORKER_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WORKER_URL },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie?.() || [];
    const sessionCookie = cookies.find((c) => c.includes("better-auth.session_token"));
    expect(sessionCookie).toContain("Max-Age=0");
  });
});
