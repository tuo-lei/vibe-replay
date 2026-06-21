/**
 * Local auth-session manager for the dashboard server (editor mode).
 *
 * Wraps the on-disk cloud auth tokens behind a small stateful session: reading
 * the active token, validating it against the cloud (with a short TTL cache),
 * clearing it on logout/expiry, and proxying authenticated requests to the
 * cloud API. Extracted from startServer as a factory so the auth state lives in
 * one closure rather than the server's top-level scope.
 */

import {
  getSessionCookieName,
  loadAllAuthTokens,
  loadAnyAuthToken,
  loadAuthToken,
  removeAuthToken,
} from "./publishers/cloud.js";

export interface LocalAuthSession {
  token: string;
  user: { id: string; name: string; email?: string; image?: string };
  /** The actual API origin this token authenticates against */
  targetApi: string;
}

export type CloudFetchResult = { unauthorized: true } | { unauthorized: false; response: Response };

export interface AuthSession {
  readLocalAuthSession(): LocalAuthSession | null;
  isAuthValid(): Promise<boolean>;
  clearLocalAuthSession(): Promise<void>;
  fetchCloudApiWithLocalAuth(path: string, init?: RequestInit): Promise<CloudFetchResult>;
}

/** Create an auth session bound to a cloud API origin. */
export function createAuthSession(cloudApiBaseUrl: string): AuthSession {
  // Track validated auth state so we don't hit the cloud on every request.
  // Invalidated on 401 from any cloud call or on explicit logout.
  let validatedAuth: { valid: boolean; checkedAt: number } | null = null;
  const AUTH_CHECK_TTL = 5 * 60 * 1000; // Re-validate every 5 minutes

  function readLocalAuthSession(): LocalAuthSession | null {
    // 1. Try exact match for current environment
    const exact = loadAuthToken(cloudApiBaseUrl);
    if (exact) {
      return {
        token: exact.token,
        user: exact.user as LocalAuthSession["user"],
        targetApi: cloudApiBaseUrl,
      };
    }
    // 2. Fallback: use any available token and proxy to its origin
    const fallback = loadAnyAuthToken();
    if (fallback) {
      return {
        token: fallback.token,
        user: fallback.user as LocalAuthSession["user"],
        targetApi: fallback.origin,
      };
    }
    return null;
  }

  function invalidateAuthCache() {
    validatedAuth = null;
  }

  async function clearLocalAuthSession() {
    // Remove ALL tokens — user expects a full logout, not per-env
    for (const entry of loadAllAuthTokens()) {
      await removeAuthToken(entry.origin);
    }
    invalidateAuthCache();
  }

  /** Build an ordered list of (token, apiUrl) pairs to try.
   *  Exact match for current env first, then any other available token. */
  function getAuthCandidates(): { token: string; apiUrl: string }[] {
    const candidates: { token: string; apiUrl: string }[] = [];
    const exact = loadAuthToken(cloudApiBaseUrl);
    if (exact) candidates.push({ token: exact.token, apiUrl: cloudApiBaseUrl });
    const fallback = loadAnyAuthToken();
    if (fallback) {
      const fallbackApi = fallback.origin;
      if (fallbackApi !== cloudApiBaseUrl) {
        candidates.push({ token: fallback.token, apiUrl: fallbackApi });
      }
    }
    return candidates;
  }

  async function fetchCloudApiWithLocalAuth(
    path: string,
    init: RequestInit = {},
  ): Promise<CloudFetchResult> {
    const candidates = getAuthCandidates();
    if (candidates.length === 0) return { unauthorized: true };

    // Try each candidate; on 401, cascade to the next one
    for (const candidate of candidates) {
      const headers = new Headers(init.headers);
      const cookieName = getSessionCookieName(candidate.apiUrl);
      headers.set("Cookie", `${cookieName}=${candidate.token}`);
      const response = await fetch(`${candidate.apiUrl}${path}`, { ...init, headers });
      if (response.status !== 401) return { unauthorized: false, response };
    }
    // All candidates returned 401 — token expired, clear it
    await clearLocalAuthSession();
    return { unauthorized: true };
  }

  /** Validate the local token against the cloud. Caches result. */
  async function isAuthValid(): Promise<boolean> {
    const now = Date.now();
    if (validatedAuth && now - validatedAuth.checkedAt < AUTH_CHECK_TTL) {
      return validatedAuth.valid;
    }
    const auth = readLocalAuthSession();
    if (!auth) {
      validatedAuth = { valid: false, checkedAt: now };
      return false;
    }
    try {
      const cookieName = getSessionCookieName(auth.targetApi);
      const resp = await fetch(`${auth.targetApi}/api/auth/get-session`, {
        headers: { Cookie: `${cookieName}=${auth.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          // Auth rejected — clear session so UI shows logged out
          await clearLocalAuthSession();
          validatedAuth = { valid: false, checkedAt: now };
          return false;
        }
        // 5xx / other non-2xx — treat like network error (offline-friendly)
        validatedAuth = { valid: true, checkedAt: now };
        return true;
      }
      const data = await resp.json();
      const valid = !!(data?.session && data.user);
      if (!valid) {
        // Token expired — clear it so UI shows logged out
        await clearLocalAuthSession();
      }
      validatedAuth = { valid, checkedAt: now };
      return valid;
    } catch {
      // Network/timeout error — assume still valid (offline-friendly)
      validatedAuth = { valid: true, checkedAt: now };
      return true;
    }
  }

  return { readLocalAuthSession, isAuthValid, clearLocalAuthSession, fetchCloudApiWithLocalAuth };
}
