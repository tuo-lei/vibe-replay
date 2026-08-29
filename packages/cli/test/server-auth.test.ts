import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHomedir = join(
  tmpdir(),
  `vibe-replay-server-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mockHomedir };
});

const { createAuthSession } = await import("../src/server-auth.js");
const { getSessionCookieName } = await import("../src/publishers/cloud.js");

function writeAuthStore(
  accounts: Record<string, { token: string; user: { id: string; name: string; email?: string } }>,
) {
  const dir = join(mockHomedir, ".config", "vibe-replay");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
}

function clearAuthStore() {
  try {
    rmSync(join(mockHomedir, ".config", "vibe-replay", "auth.json"), { force: true });
  } catch {}
}

describe("createAuthSession", () => {
  const PROD = "https://vibe-replay.com";
  const DEV = "http://localhost:8787";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAuthStore();
  });

  describe("readLocalAuthSession", () => {
    it("returns exact match when token exists for current env", () => {
      writeAuthStore({
        [PROD]: { token: "prod-token", user: { id: "u1", name: "Prod" } },
        [DEV]: { token: "dev-token", user: { id: "u2", name: "Dev" } },
      });
      const s = createAuthSession(PROD);
      expect(s.readLocalAuthSession()).toEqual({
        token: "prod-token",
        user: { id: "u1", name: "Prod" },
        targetApi: PROD,
      });
    });

    it("falls back to any token when exact env has no token", () => {
      writeAuthStore({
        [PROD]: { token: "prod-token", user: { id: "u1", name: "Prod" } },
      });
      const s = createAuthSession(DEV);
      const auth = s.readLocalAuthSession();
      expect(auth).not.toBeNull();
      expect(auth?.token).toBe("prod-token");
      expect(auth?.targetApi).toBe(PROD);
    });

    it("returns null when no tokens stored", () => {
      clearAuthStore();
      const s = createAuthSession(PROD);
      expect(s.readLocalAuthSession()).toBeNull();
    });

    it("prefers exact over fallback when both exist", () => {
      writeAuthStore({
        [PROD]: { token: "prod-token", user: { id: "u1", name: "Prod" } },
        [DEV]: { token: "dev-token", user: { id: "u2", name: "Dev" } },
      });
      const s = createAuthSession(DEV);
      expect(s.readLocalAuthSession()?.token).toBe("dev-token");
      expect(s.readLocalAuthSession()?.targetApi).toBe(DEV);
    });
  });

  describe("fetchCloudApiWithLocalAuth", () => {
    it("returns unauthorized when no candidates", async () => {
      clearAuthStore();
      const s = createAuthSession(PROD);
      const res = await s.fetchCloudApiWithLocalAuth("/api/foo");
      expect(res.unauthorized).toBe(true);
    });

    it("succeeds on first candidate without trying fallback", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(PROD);
      const res = await s.fetchCloudApiWithLocalAuth("/api/data");
      expect(res.unauthorized).toBe(false);
      if (!res.unauthorized) expect(res.response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe(`${PROD}/api/data`);
      const headers = fetchMock.mock.calls[0][1].headers as Headers;
      expect(headers.get("Cookie")).toBe(`${getSessionCookieName(PROD)}=t1`);
    });

    it("cascades to fallback on 401 and returns its response", async () => {
      writeAuthStore({
        [PROD]: { token: "prod", user: { id: "u1", name: "Prod" } },
        [DEV]: { token: "dev", user: { id: "u2", name: "Dev" } },
      });
      // createAuthSession bound to DEV? Actually fallback logic: candidates are exact(DEV)+fallback(PROD) when bound to DEV but only PROD exists.
      // To test cascade, bind to DEV with exact DEV + fallback PROD => fetch DEV 401 then PROD 200
      writeAuthStore({
        [PROD]: { token: "prod", user: { id: "u2", name: "Prod" } },
        [DEV]: { token: "dev", user: { id: "u1", name: "Dev" } },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(DEV);
      const res = await s.fetchCloudApiWithLocalAuth("/api/data");
      expect(res.unauthorized).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0] as string).toBe(`${DEV}/api/data`);
      expect(fetchMock.mock.calls[1][0] as string).toBe(`${PROD}/api/data`);
    });

    it("clears all tokens when all candidates return 401", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(PROD);
      const res = await s.fetchCloudApiWithLocalAuth("/api/data");
      expect(res.unauthorized).toBe(true);
      // store cleared
      expect(s.readLocalAuthSession()).toBeNull();
    });

    it("does not de-duplicate when fallback origin equals exact (no duplicate fetch)", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(PROD);
      await s.fetchCloudApiWithLocalAuth("/api/data");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("isAuthValid", () => {
    it("returns false when no local auth", async () => {
      clearAuthStore();
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(false);
    });

    it("caches result within TTL and does not re-fetch", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session: { token: "t1" }, user: { id: "u1", name: "A" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // second call within TTL → cached
      expect(await s.isAuthValid()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // advance past TTL (5min) → re-fetch
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(await s.isAuthValid()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns true and caches valid on 200 with session+user", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ session: { token: "t1" }, user: { id: "u1", name: "A" } }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      );
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(true);
    });

    it("clears and returns false when 200 has no session (expired)", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ session: null, user: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(false);
      expect(s.readLocalAuthSession()).toBeNull();
    });

    it("clears and returns false on 401", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
      );
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(false);
      expect(s.readLocalAuthSession()).toBeNull();
    });

    it("clears and returns false on 403", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(false);
      expect(s.readLocalAuthSession()).toBeNull();
    });

    it("returns true (offline-friendly) on 500 without clearing", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(true);
      expect(s.readLocalAuthSession()).not.toBeNull();
    });

    it("returns true on network/timeout error without clearing", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(true);
      expect(s.readLocalAuthSession()).not.toBeNull();
    });

    it("uses correct cookie name per targetApi (https vs http)", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session: { token: "t1" }, user: { id: "u1", name: "A" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const s = createAuthSession(PROD);
      await s.isAuthValid();
      const cookieValue = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
      const actualCookie =
        cookieValue instanceof Headers
          ? cookieValue.get("Cookie")
          : (cookieValue as unknown as Record<string, string>)["Cookie"];
      expect(actualCookie).toBe(`${getSessionCookieName(PROD)}=t1`);

      // http origin uses non-secure cookie
      clearAuthStore();
      writeAuthStore({ [DEV]: { token: "d1", user: { id: "u2", name: "B" } } });
      const fetchMock2 = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ session: { token: "d1" }, user: { id: "u2", name: "B" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock2);
      const s2 = createAuthSession(DEV);
      await s2.isAuthValid();
      const headers2 = (fetchMock2.mock.calls[0][1] as RequestInit).headers as Headers;
      const cookie2 =
        headers2 instanceof Headers
          ? headers2.get("Cookie")
          : (headers2 as unknown as Record<string, string>)["Cookie"];
      expect(cookie2).toBe(`${getSessionCookieName(DEV)}=d1`);
    });

    it("returns true when fetch returns 200 but json() throws (offline-friendly)", async () => {
      writeAuthStore({ [PROD]: { token: "t1", user: { id: "u1", name: "A" } } });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("bad json")),
          headers: new Headers(),
        } as unknown as Response),
      );
      const s = createAuthSession(PROD);
      expect(await s.isAuthValid()).toBe(true);
      expect(s.readLocalAuthSession()).not.toBeNull();
    });
  });

  describe("clearLocalAuthSession", () => {
    it("removes all tokens and invalidates cache", async () => {
      writeAuthStore({
        [PROD]: { token: "t1", user: { id: "u1", name: "A" } },
        [DEV]: { token: "t2", user: { id: "u2", name: "B" } },
      });
      const s = createAuthSession(PROD);
      // prime cache
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ session: { token: "t1" }, user: { id: "u1", name: "A" } }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      );
      expect(await s.isAuthValid()).toBe(true);
      await s.clearLocalAuthSession();
      expect(s.readLocalAuthSession()).toBeNull();
      // after clear, isAuthValid should return false (no re-use of cached true)
      vi.stubGlobal("fetch", vi.fn());
      expect(await s.isAuthValid()).toBe(false);
    });
  });
});
