import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getApiUrl, getSessionCookieName, loadAuthToken } from "./cloud.js";

const GIST_META_FILE = ".vibe-replay-gist.json";

export interface GistResult {
  gistId: string;
  filename: string;
  gistUrl: string;
  viewerUrl: string;
  mode: "created" | "updated";
}

export interface SavedGistInfo {
  gistId: string;
  filename: string;
  gistUrl: string;
  viewerUrl: string;
  updatedAt: string;
  contentHash?: string;
}

export interface PublishGistOptions {
  overwrite?: SavedGistInfo;
}

/** Check if gist publish is available (user is logged in) */
export function checkPublishStatus(): { available: true } | { available: false; reason: string } {
  const auth = loadAuthToken();
  if (auth) return { available: true };
  return { available: false, reason: "Run `vibe-replay auth login` to publish" };
}

export async function publishGist(
  outputDir: string,
  title: string,
  opts?: PublishGistOptions,
): Promise<GistResult> {
  const auth = loadAuthToken();
  if (!auth) {
    throw new Error("Not logged in. Run `vibe-replay auth login` first.");
  }

  const jsonPath = join(outputDir, "replay.json");
  const content = await readFile(jsonPath, "utf-8");
  const overwrite = opts?.overwrite;
  const filename = overwrite?.filename || `${sanitizeFilename(title)}.json`;
  const description = `vibe-replay: ${title}`;
  const apiUrl = getApiUrl();

  let gistId: string;
  let gistUrl: string;
  let viewerUrl: string;
  let mode: GistResult["mode"];

  if (overwrite) {
    // Update existing gist
    const resp = await fetch(`${apiUrl}/api/gists/${overwrite.gistId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${getSessionCookieName(apiUrl)}=${auth.token}`,
      },
      body: JSON.stringify({ filename, content, description }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(
        `Gist update failed: ${(err as { error?: string }).error || resp.statusText}`,
      );
    }
    const data = (await resp.json()) as { gistId: string; gistUrl: string; viewerUrl: string };
    gistId = data.gistId;
    gistUrl = data.gistUrl;
    viewerUrl = data.viewerUrl;
    mode = "updated";
  } else {
    // Create new gist
    const resp = await fetch(`${apiUrl}/api/gists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${getSessionCookieName(apiUrl)}=${auth.token}`,
      },
      body: JSON.stringify({ filename, content, description, public: true }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      if ((resp.status as number) === 401) {
        throw new Error("Session expired. Run `vibe-replay auth login` to re-authenticate.");
      }
      throw new Error(
        `Gist publish failed: ${(err as { error?: string }).error || resp.statusText}`,
      );
    }
    const data = (await resp.json()) as { gistId: string; gistUrl: string; viewerUrl: string };
    gistId = data.gistId;
    gistUrl = data.gistUrl;
    viewerUrl = data.viewerUrl;
    mode = "created";
  }

  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  await saveGistInfo(outputDir, {
    gistId,
    filename,
    gistUrl,
    viewerUrl,
    updatedAt: new Date().toISOString(),
    contentHash,
  });

  return { gistId, filename, gistUrl, viewerUrl, mode };
}

export async function loadSavedGistInfo(outputDir: string): Promise<SavedGistInfo | undefined> {
  try {
    const raw = await readFile(join(outputDir, GIST_META_FILE), "utf-8");
    const parsed = JSON.parse(raw) as SavedGistInfo;
    if (!parsed?.gistId || !parsed?.filename) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveGistInfo(outputDir: string, info: SavedGistInfo): Promise<void> {
  await writeFile(join(outputDir, GIST_META_FILE), JSON.stringify(info, null, 2), "utf-8");
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}
