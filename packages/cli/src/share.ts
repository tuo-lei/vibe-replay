import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import chalk from "chalk";
import { generateOutput } from "./generator.js";
import { loadOverlays, sessionForExternalOutput, sessionWithEffectiveContent } from "./overlays.js";
import { publishCloudWithOverlays } from "./publishers/cloud.js";
import { tryPublishLocal } from "./publishers/local.js";
import { loadAnnotations } from "./server-persistence.js";
import type { ReplaySession } from "./types.js";
import { expandUserPath } from "./utils.js";

export const SHARE_VISIBILITIES = ["public", "unlisted", "private"] as const;
export type ShareVisibility = (typeof SHARE_VISIBILITIES)[number];

/** Adjacent no-auth generate path shown when share has nothing to open. */
export const LOCAL_PREVIEW_HINT = "vibe-replay --session <path> --open";

export class ShareError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ShareError";
    this.exitCode = exitCode;
  }
}

export type CloudShareResult = { mode: "cloud"; url: string; expiresAt: string };

export type LocalShareFallbackResult = {
  mode: "local-fallback";
  htmlPath: string;
  fileUrl: string;
  opened: boolean;
};

export type ShareResult = CloudShareResult | LocalShareFallbackResult;

export interface ShareReplayDeps {
  ensureHtml?: (outputDir: string) => Promise<string>;
  generateHtml?: (session: ReplaySession, outputDir: string) => Promise<string>;
  openHtml?: (htmlPath: string) => Promise<boolean>;
  publishCloud?: (
    outputDir: string,
    opts?: { visibility?: ShareVisibility },
  ) => Promise<{ url: string; expiresAt: string }>;
}

export function replayHtmlPath(outputDir: string): string {
  return join(outputDir, "index.html");
}

export function replayJsonPath(outputDir: string): string {
  return join(outputDir, "replay.json");
}

/** Resolve a user-supplied share path to the replay directory. */
export function resolveShareReplayDir(pathArg: string): string {
  const abs = resolve(expandUserPath(pathArg));
  if (!existsSync(abs)) {
    throw new ShareError(`Path not found: ${abs}`);
  }
  const stats = statSync(abs);
  return stats.isDirectory() ? abs : dirname(abs);
}

export function requireReplayDir(pathArg: string): string {
  const outputDir = resolveShareReplayDir(pathArg);
  if (!existsSync(replayJsonPath(outputDir))) {
    throw new ShareError(`No replay.json found in ${outputDir}`);
  }
  return outputDir;
}

/**
 * Build a shareable `index.html` from the current replay, matching cloud/HTML
 * export: apply editor overlays + annotations, then strip SSH gitRepo.
 *
 * Never reuse a stale on-disk HTML. `generateOutput` also writes replay.json,
 * so the original file is restored afterward.
 */
export async function ensureLocalReplayHtml(
  outputDir: string,
  generate: (session: ReplaySession, outputDir: string) => Promise<string> = generateOutput,
): Promise<string> {
  const jsonPath = replayJsonPath(outputDir);
  if (!existsSync(jsonPath)) {
    throw new ShareError(`No replay.json found in ${outputDir}`);
  }

  const originalContent = await readFile(jsonPath, "utf-8");
  const session = JSON.parse(originalContent) as ReplaySession;
  const slug = basename(outputDir);
  const baseDir = dirname(outputDir);
  const overlays = await loadOverlays(baseDir, slug);
  const annotations = await loadAnnotations(baseDir, slug);
  if (annotations.length > 0) session.annotations = annotations;

  const shareable = sessionForExternalOutput(sessionWithEffectiveContent(session, overlays));
  try {
    return await generate(shareable, outputDir);
  } finally {
    await writeFile(jsonPath, originalContent, "utf-8");
  }
}

export function describeLocalShareFallback(
  htmlPath: string,
  opened: boolean,
): LocalShareFallbackResult {
  return {
    mode: "local-fallback",
    htmlPath,
    fileUrl: pathToFileURL(htmlPath).href,
    opened,
  };
}

/**
 * Share a replay. Cloud upload when logged in; otherwise write/open local HTML
 * so a first-run user is not dead-ended by `auth login`.
 */
export async function shareReplay(
  outputDir: string,
  options: {
    loggedIn: boolean;
    visibility?: ShareVisibility;
    open?: boolean;
  } & ShareReplayDeps,
): Promise<ShareResult> {
  if (!existsSync(replayJsonPath(outputDir))) {
    throw new ShareError(`No replay.json found in ${outputDir}`);
  }

  if (options.loggedIn) {
    const publish = options.publishCloud ?? publishCloudWithOverlays;
    const result = await publish(outputDir, { visibility: options.visibility });
    return { mode: "cloud", url: result.url, expiresAt: result.expiresAt };
  }

  const ensureHtml =
    options.ensureHtml ??
    ((dir) => ensureLocalReplayHtml(dir, options.generateHtml ?? generateOutput));
  const htmlPath = await ensureHtml(outputDir);
  const shouldOpen = options.open !== false && process.env.VIBE_REPLAY_NO_AUTO_OPEN !== "1";
  let opened = false;
  if (shouldOpen) {
    const openHtml = options.openHtml ?? tryPublishLocal;
    opened = await openHtml(htmlPath);
  }
  return describeLocalShareFallback(htmlPath, opened);
}

export function printLocalShareFallback(result: LocalShareFallbackResult): void {
  console.log();
  console.log(chalk.yellow("  Cloud share skipped (not logged in)."));
  if (result.opened) {
    console.log(chalk.green("  Opened the local HTML in your browser."));
  } else {
    console.log(chalk.green("  Local HTML is ready — no account needed."));
  }
  console.log();
  console.log(chalk.dim("  File:  ") + chalk.white(result.htmlPath));
  console.log(chalk.dim("  Open:  ") + chalk.cyan(result.fileUrl));
  console.log(
    chalk.dim("  Share: ") + chalk.white("send this HTML file to anyone — it is self-contained"),
  );
  console.log(chalk.dim("  Cloud: ") + chalk.white("vibe-replay auth login"));
  console.log();
}
