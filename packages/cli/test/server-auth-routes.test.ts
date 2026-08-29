import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAuthRoutes } from "../src/server-routes/auth.js";

function makeApp(deps: Parameters<typeof registerAuthRoutes>[1]) {
  const app = new Hono();
  registerAuthRoutes(app, deps);
  return app;
}

describe("registerAuthRoutes", () => {
  it("/api/auth/status returns false when no local auth", async () => {
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => null,
      isAuthValid: vi.fn().mockResolvedValue(false),
      clearLocalAuthSession: vi.fn(),
      autoSyncInsights: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/api/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null });
  });

  it("/api/auth/status returns false when token invalid", async () => {
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => ({
        token: "t",
        user: { id: "u1", name: "A" },
        targetApi: "https://vibe-replay.com",
      }),
      isAuthValid: vi.fn().mockResolvedValue(false),
      clearLocalAuthSession: vi.fn(),
      autoSyncInsights: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/api/auth/status");
    expect((await res.json()).authenticated).toBe(false);
  });

  it("/api/auth/status returns true when valid", async () => {
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => ({
        token: "t",
        user: { id: "u1", name: "Alice" },
        targetApi: "https://vibe-replay.com",
      }),
      isAuthValid: vi.fn().mockResolvedValue(true),
      clearLocalAuthSession: vi.fn(),
      autoSyncInsights: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/api/auth/status");
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.name).toBe("Alice");
  });

  it("/api/auth/get-session mirrors status shape", async () => {
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => ({
        token: "tok",
        user: { id: "u1", name: "Bob" },
        targetApi: "https://vibe-replay.com",
      }),
      isAuthValid: vi.fn().mockResolvedValue(true),
      clearLocalAuthSession: vi.fn(),
      autoSyncInsights: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/api/auth/get-session");
    const body = await res.json();
    expect(body.session.token).toBe("tok");
    expect(body.user.name).toBe("Bob");
  });

  it("/api/auth/get-session returns null session when no auth", async () => {
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => null,
      isAuthValid: vi.fn().mockResolvedValue(false),
      clearLocalAuthSession: vi.fn(),
      autoSyncInsights: vi.fn().mockResolvedValue(undefined),
    });
    const res = await app.request("/api/auth/get-session");
    expect((await res.json()).session).toBeNull();
  });

  it("/api/auth/logout clears and returns success", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => null,
      isAuthValid: vi.fn(),
      clearLocalAuthSession: clear,
      autoSyncInsights: vi.fn(),
    });
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("/api/auth/sign-out alias also clears", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      cloudApiBaseUrl: "https://vibe-replay.com",
      readLocalAuthSession: () => null,
      isAuthValid: vi.fn(),
      clearLocalAuthSession: clear,
      autoSyncInsights: vi.fn(),
    });
    const res = await app.request("/api/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
