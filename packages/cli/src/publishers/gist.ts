import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);

const VIEWER_BASE_URL = "https://vibe-replay.com/view";

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
  gistUrl: string;
  viewerUrl: string;
}

export async function publishGist(
  outputDir: string,
  title: string,
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
  const filename = `${sanitizeFilename(title)}.json`;

  // Upload replay.json to gist
  const { stdout } = await exec("gh", [
    "gist",
    "create",
    "--public",
    "--desc",
    `vibe-replay: ${title}`,
    "--filename",
    filename,
    jsonPath,
  ]);

  const gistUrl = stdout.trim();
  const gistId = gistUrl.split("/").pop();

  // Construct viewer URL — clean gist ID link
  const viewerUrl = `${VIEWER_BASE_URL}/?gist=${gistId}`;

  return { gistUrl, viewerUrl };
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}
