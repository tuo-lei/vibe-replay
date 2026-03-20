import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOUD_META_FILE = ".vibe-replay-cloud.json";
const DEFAULT_API_URL = "https://vibe-replay.com";
const AUTH_DIR = join(homedir(), ".config", "vibe-replay");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

export interface CloudResult {
  id: string;
  url: string;
  expiresAt: string;
}

export interface SavedCloudInfo {
  id: string;
  url: string;
  expiresAt: string;
  updatedAt: string;
}

export interface AuthData {
  token: string;
  user: { id: string; name: string; email?: string; image?: string };
}

/** Normalize URL to origin (protocol + host) for use as auth store key */
function authOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

interface AuthStore {
  accounts: Record<string, AuthData>;
}

/** Read the auth store, migrating from legacy flat format if needed */
function readAuthStore(): AuthStore {
  try {
    if (!existsSync(AUTH_FILE)) return { accounts: {} };
    const raw = readFileSync(AUTH_FILE, "utf-8");
    const data = JSON.parse(raw);
    // Legacy flat format: { token, user } → migrate under default production origin
    if (data.token && data.user && !data.accounts) {
      return {
        accounts: { [authOrigin(DEFAULT_API_URL)]: { token: data.token, user: data.user } },
      };
    }
    if (data.accounts && typeof data.accounts === "object") return data as AuthStore;
    return { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

function writeAuthStoreSync(store: AuthStore): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function writeAuthStoreAsync(store: AuthStore): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Load auth token for the given API URL (defaults to current VIBE_REPLAY_API_URL) */
export function loadAuthToken(apiUrl?: string): AuthData | null {
  const store = readAuthStore();
  const origin = authOrigin(apiUrl || getApiUrl());
  const entry = store.accounts[origin];
  if (!entry?.token || !entry?.user) return null;
  return entry;
}

/** Load any available auth token, returning which origin it belongs to.
 *  Used by BFF proxy: if no token for the current env, use whatever we have
 *  and proxy to THAT origin instead. */
export function loadAnyAuthToken(): (AuthData & { origin: string }) | null {
  const store = readAuthStore();
  for (const [origin, entry] of Object.entries(store.accounts)) {
    if (entry?.token && entry?.user) {
      return { ...entry, origin };
    }
  }
  return null;
}

/** Save auth token keyed by API URL origin (sync, for CLI callback handlers) */
export function saveAuthTokenSync(data: AuthData, apiUrl?: string): void {
  const store = readAuthStore();
  store.accounts[authOrigin(apiUrl || getApiUrl())] = data;
  writeAuthStoreSync(store);
}

/** Save auth token keyed by API URL origin (async) */
export async function saveAuthToken(data: AuthData, apiUrl?: string): Promise<void> {
  const store = readAuthStore();
  store.accounts[authOrigin(apiUrl || getApiUrl())] = data;
  await writeAuthStoreAsync(store);
}

/** Remove auth token for the given API URL origin. Deletes file if no accounts remain. */
export async function removeAuthToken(apiUrl?: string): Promise<void> {
  const store = readAuthStore();
  delete store.accounts[authOrigin(apiUrl || getApiUrl())];
  if (Object.keys(store.accounts).length === 0) {
    try {
      await unlink(AUTH_FILE);
    } catch {
      // Already gone
    }
  } else {
    await writeAuthStoreAsync(store);
  }
}

/** Remove auth token (sync). Deletes file if no accounts remain. */
export function removeAuthTokenSync(apiUrl?: string): void {
  const store = readAuthStore();
  delete store.accounts[authOrigin(apiUrl || getApiUrl())];
  if (Object.keys(store.accounts).length === 0) {
    try {
      rmSync(AUTH_FILE);
    } catch {
      // Already gone
    }
  } else {
    writeAuthStoreSync(store);
  }
}

/** Get the auth file path (for display purposes) */
export function getAuthFilePath(): string {
  return AUTH_FILE;
}

export function getApiUrl(): string {
  return process.env.VIBE_REPLAY_API_URL || DEFAULT_API_URL;
}

/** HTTPS targets use __Secure- prefixed cookie names (Better Auth convention) */
export function getSessionCookieName(apiUrl?: string): string {
  const url = apiUrl || getApiUrl();
  return url.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
}

export async function publishCloud(
  outputDir: string,
  opts?: { visibility?: "public" | "unlisted" | "private" },
): Promise<CloudResult> {
  const auth = loadAuthToken();
  if (!auth) {
    throw new Error("Not logged in. Run `vibe-replay auth login` first.");
  }

  const jsonPath = join(outputDir, "replay.json");
  const content = await readFile(jsonPath, "utf-8");
  const replay = JSON.parse(content);

  const sizeBytes = Buffer.byteLength(content, "utf-8");
  const MAX_SIZE = 10 * 1024 * 1024;
  if (sizeBytes > MAX_SIZE) {
    throw new Error(
      `Replay too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Max 10MB for cloud sharing.`,
    );
  }

  const apiUrl = getApiUrl();
  const resp = await fetch(`${apiUrl}/api/cloud-replays`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${getSessionCookieName(apiUrl)}=${auth.token}`,
    },
    body: JSON.stringify({
      replay,
      visibility: opts?.visibility || "unlisted",
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    if (resp.status === 401) {
      throw new Error("Session expired. Run `vibe-replay auth login` to re-authenticate.");
    }
    if (resp.status === 413) {
      throw new Error((err as { error?: string }).error || "Storage quota exceeded");
    }
    throw new Error(`Upload failed: ${(err as { error?: string }).error || resp.statusText}`);
  }

  const data = (await resp.json()) as CloudResult;

  await saveCloudInfo(outputDir, {
    id: data.id,
    url: data.url,
    expiresAt: data.expiresAt,
    updatedAt: new Date().toISOString(),
  });

  return data;
}

export async function loadSavedCloudInfo(outputDir: string): Promise<SavedCloudInfo | undefined> {
  try {
    const raw = await readFile(join(outputDir, CLOUD_META_FILE), "utf-8");
    const parsed = JSON.parse(raw) as SavedCloudInfo;
    if (!parsed?.id || !parsed?.url) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveCloudInfo(outputDir: string, info: SavedCloudInfo): Promise<void> {
  await writeFile(join(outputDir, CLOUD_META_FILE), JSON.stringify(info, null, 2), "utf-8");
}
