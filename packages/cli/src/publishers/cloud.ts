import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLOUD_META_FILE = ".vibe-replay-cloud.json";
const DEFAULT_API_URL = "https://vibe-replay.com";

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

interface AuthData {
  token: string;
  user: { id: string; name: string; email?: string };
}

export function loadAuthToken(): AuthData | null {
  try {
    const authPath = join(homedir(), ".config", "vibe-replay", "auth.json");
    if (!existsSync(authPath)) return null;
    const raw = readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw);
    if (data.token && data.user) return data;
    return null;
  } catch {
    return null;
  }
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
