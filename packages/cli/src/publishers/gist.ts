import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const exec = promisify(execFile);

const VIEWER_BASE_URL = "https://vibe-replay.com/view";
const GIST_META_FILE = ".vibe-replay-gist.json";

export type GhStatus =
  | { available: true }
  | { available: false; reason: "not-installed" | "not-authenticated" };

/**
 * Pre-check whether `gh` CLI is installed and authenticated.
 * Use this to show hints in the menu before the user selects gist.
 */
export async function checkGhStatus(): Promise<GhStatus> {
  try {
    await exec("which", ["gh"]);
  } catch {
    return { available: false, reason: "not-installed" };
  }
  try {
    await exec("gh", ["auth", "status"]);
  } catch {
    return { available: false, reason: "not-authenticated" };
  }
  return { available: true };
}

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
}

export interface PublishGistOptions {
  overwrite?: SavedGistInfo;
}

export async function publishGist(
  outputDir: string,
  title: string,
  opts?: PublishGistOptions,
): Promise<GistResult> {
  // Check if gh CLI is available
  try {
    await exec("gh", ["auth", "status"]);
  } catch {
    throw new Error(
      "GitHub CLI (gh) is not installed or not authenticated.\n" +
        "Install: https://cli.github.com/\n" +
        "Auth: gh auth login",
    );
  }

  const jsonPath = join(outputDir, "replay.json");
  const overwrite = opts?.overwrite;
  const filename = overwrite?.filename || `${sanitizeFilename(title)}.json`;
  const desc = `vibe-replay: ${title}`;
  let gistId = "";
  let gistUrl = "";
  let mode: GistResult["mode"] = "created";

  if (overwrite) {
    await exec("gh", [
      "gist",
      "edit",
      overwrite.gistId,
      jsonPath,
      "--filename",
      filename,
      "--desc",
      desc,
    ]);
    gistId = overwrite.gistId;
    gistUrl = overwrite.gistUrl || `https://gist.github.com/${gistId}`;
    mode = "updated";
  } else {
    // Upload replay.json to gist
    const { stdout } = await exec("gh", [
      "gist",
      "create",
      "--public",
      "--desc",
      desc,
      "--filename",
      filename,
      jsonPath,
    ]);
    gistUrl = stdout.trim();
    gistId = extractGistId(stdout.trim());
  }

  // Construct viewer URL — clean gist ID link
  const viewerUrl = `${VIEWER_BASE_URL}/?gist=${gistId}`;
  if (!gistUrl) gistUrl = `https://gist.github.com/${gistId}`;
  await saveGistInfo(outputDir, {
    gistId,
    filename,
    gistUrl,
    viewerUrl,
    updatedAt: new Date().toISOString(),
  });

  return { gistId, filename, gistUrl, viewerUrl, mode };
}

export async function loadSavedGistInfo(
  outputDir: string,
): Promise<SavedGistInfo | undefined> {
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

function extractGistId(gistUrlOrId: string): string {
  const trimmed = gistUrlOrId.trim();
  const urlMatch = trimmed.match(/([a-f0-9]{20,40})$/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  throw new Error(`Unexpected gist output: ${gistUrlOrId}`);
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}
