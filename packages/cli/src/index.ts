import http from "node:http";
import { Separator, select } from "@inquirer/prompts";
import chalk from "chalk";
import { program } from "commander";
import ora from "ora";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText } from "./clean-prompt.js";
import {
  checkCleanupWarnings,
  computeDaysUntilCleanup,
  getClaudeCodeCleanupPeriod,
  WARNING_THRESHOLD_DAYS,
} from "./cleanup-warning.js";
import { generateGitHubGif } from "./formatters/gif.js";
import { generateGitHubMarkdown, generateGitHubSvg } from "./formatters/github.js";
import { generateOutput } from "./generator.js";
import { deduplicateSessionsByProvider, getAllProviders, getProvider } from "./providers/index.js";
import {
  DEFAULT_API_URL,
  getAuthFilePath,
  loadAuthToken,
  publishCloudWithOverlays,
  removeAuthTokenSync,
  saveAuthTokenSync,
} from "./publishers/cloud.js";
import {
  checkPublishStatus,
  loadSavedGistInfo,
  publishGist,
  type SavedGistInfo,
} from "./publishers/gist.js";
import { publishLocal } from "./publishers/local.js";
import { scanForSecrets } from "./scan.js";
import { startDashboard, startServer } from "./server.js";
import { transformToReplay } from "./transform.js";
import type { ReplaySession, SessionInfo } from "./types.js";
import { normalizeTitle } from "./utils.js";
import { CLI_VERSION } from "./version.js";

interface GitHubExportResult {
  markdown: string;
  outputDir: string;
  svgPath: string;
  gifPath?: string;
  mdPath: string;
  redactionsPath: string;
}

async function runGitHubExport(
  replay: ReplaySession,
  outputDir: string,
): Promise<GitHubExportResult> {
  const { join } = await import("node:path");
  const { writeFile } = await import("node:fs/promises");

  // Auto-detect replay URL from previously published gist
  const savedGist = await loadSavedGistInfo(outputDir);
  const replayUrl = savedGist?.viewerUrl;

  // Generate animated SVG
  const svgSpinner = ora("Generating animated SVG...").start();
  const svgContent = generateGitHubSvg(replay, { replayUrl });
  const svgFilePath = join(outputDir, "session-preview.svg");
  await writeFile(svgFilePath, svgContent, "utf-8");
  svgSpinner.succeed(`SVG: ${svgFilePath}`);

  // Generate animated GIF
  let gifGenerated = false;
  const gifSpinner = ora("Generating animated GIF...").start();
  try {
    const gifBuffer = await generateGitHubGif(replay, { replayUrl });
    const gifFilePath = join(outputDir, "session-preview.gif");
    await writeFile(gifFilePath, gifBuffer);
    const gifSizeKB = Math.round(gifBuffer.length / 1024);
    gifSpinner.succeed(`GIF: ${gifFilePath} (${gifSizeKB} KB)`);
    gifGenerated = true;
  } catch (err) {
    gifSpinner.fail(`GIF generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Generate markdown (prefer GIF for universal GitHub support)
  const mdSpinner = ora("Generating GitHub markdown...").start();
  const markdown = generateGitHubMarkdown(replay, {
    replayUrl,
    svgPath: "./session-preview.svg",
    gifPath: gifGenerated ? "./session-preview.gif" : undefined,
  });
  const mdFilePath = join(outputDir, "github-summary.md");
  await writeFile(mdFilePath, markdown, "utf-8");
  mdSpinner.succeed(`Markdown: ${mdFilePath}`);

  // Redaction report: lets agents/users audit what was filtered before sharing.
  // - alreadyRedactedCount: counts [REDACTED] markers from transform.ts (layer 1)
  // - leftoverFindings: layer-2 scan of the final markdown for anything that slipped past
  const redactionsSpinner = ora("Generating redaction report...").start();
  const alreadyRedactedCount = (markdown.match(/\[REDACTED\]/g) || []).length;
  const leftoverFindings = scanForSecrets(markdown);
  const redactionsReport = {
    version: 1,
    source: "github-summary.md",
    alreadyRedactedCount,
    leftoverFindings,
    notes: [
      "alreadyRedactedCount: substrings replaced by transform.ts before this export.",
      "leftoverFindings: regex matches in the final markdown — review these before sharing.",
    ],
  };
  const redactionsPath = join(outputDir, "redactions.json");
  await writeFile(redactionsPath, `${JSON.stringify(redactionsReport, null, 2)}\n`, "utf-8");
  const leftoverNote =
    leftoverFindings.length > 0
      ? chalk.yellow(`(${leftoverFindings.length} leftover finding(s) — review)`)
      : chalk.dim("(no leftover findings)");
  redactionsSpinner.succeed(`Redactions: ${redactionsPath} ${leftoverNote}`);

  return {
    markdown,
    outputDir,
    svgPath: svgFilePath,
    gifPath: gifGenerated ? join(outputDir, "session-preview.gif") : undefined,
    mdPath: mdFilePath,
    redactionsPath,
  };
}

const DEV_MENU_ENABLED = process.env.VIBE_REPLAY_DEV_MENU === "1";

function getDevViewerOpts(): { externalViewerUrl: string } | undefined {
  if (!DEV_MENU_ENABLED) return undefined;
  return { externalViewerUrl: `http://localhost:${process.env.VIBE_VIEWER_PORT || "5173"}` };
}
// Bumped v2 → v3 alongside the Cowork sessionId fix (see server.ts
// sourcesCacheKey comment). Old caches carry the wrong Cowork identity and
// must be thrown out so the next discovery sweep writes a correct one.
const SESSION_DISCOVERY_CACHE_KEY = "session-discovery-v3";

function normalizePromptTitle(value?: string): string {
  return normalizeTitle(cleanPromptText(value || "")) || "";
}

function suggestedReplayTitle(
  replayTitle: string | undefined,
  replaySlug: string,
  sessionInfo?: SessionInfo,
): string {
  const slug = normalizeTitle(replaySlug);
  const replayCandidate = normalizeTitle(replayTitle);
  if (replayCandidate && replayCandidate !== slug) return replayCandidate;

  const sessionTitle = normalizeTitle(sessionInfo?.title);
  if (sessionTitle && sessionTitle !== slug) return sessionTitle;

  for (const prompt of sessionInfo?.prompts || []) {
    const promptTitle = normalizePromptTitle(prompt);
    if (promptTitle) return promptTitle;
  }
  const firstPromptTitle = normalizePromptTitle(sessionInfo?.firstPrompt);
  if (firstPromptTitle) return firstPromptTitle;

  return replayCandidate || slug || replaySlug;
}

async function discoverAllSessions(): Promise<SessionInfo[]> {
  const providers = getAllProviders();
  const allSessions: SessionInfo[] = [];
  for (const provider of providers) {
    const sessions = await provider.discover();
    allSessions.push(...sessions);
  }

  const deduped = deduplicateSessionsByProvider(allSessions);
  deduped.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return deduped;
}

program
  .name("vibe-replay")
  .description("AI Coding Session Replay & Sharing Tool")
  .version(CLI_VERSION)
  .option("-s, --session <path>", "Path to a specific JSONL session file")
  .option("-p, --provider <name>", "Provider name (default: claude-code)", "claude-code")
  .option(
    "-t, --title <name>",
    "Custom title for the replay (shown on landing page & shared links)",
  )
  .option("-d, --dashboard", "Open Dashboard directly (skip session picker)")
  .option("--open", "After generation, open in browser and exit (non-interactive)")
  .option(
    "--github",
    "Generate GitHub export (markdown + animated GIF + SVG) and exit (non-interactive)",
  )
  .action(async (opts) => {
    console.log(chalk.bold.cyan("\n  vibe-replay") + chalk.dim(` v${CLI_VERSION}\n`));

    // Windows is not supported yet (see https://github.com/tuo-lei/vibe-replay/issues/26)
    if (process.platform === "win32") {
      console.log(chalk.yellow("  ⚠ Windows is not supported yet.\n"));
      console.log(chalk.dim("  We're working on it! Follow progress and updates:"));
      console.log(
        chalk.dim("  → ") + chalk.white("https://github.com/tuo-lei/vibe-replay/issues/26"),
      );
      console.log(chalk.dim("  → ") + chalk.white("https://vibe-replay.com\n"));
      process.exit(1);
    }

    const { join: pathJoin } = await import("node:path");
    const { homedir } = await import("node:os");
    const replayBaseDir = pathJoin(homedir(), ".vibe-replay");

    // Pre-warm session discovery cache while user reads the menu
    // Fire-and-forget: never blocks the UI, silently caches results
    void discoverAllSessions()
      .then(async (sessions) => {
        await writeFileCache(SESSION_DISCOVERY_CACHE_KEY, sessions);
      })
      .catch(() => {});

    // --dashboard: open Dashboard directly
    if (opts.dashboard) {
      await startDashboard(replayBaseDir, getDevViewerOpts());
      return;
    }

    // --open/--github require --session (non-interactive modes need an explicit session path)
    if ((opts.open || opts.github) && !opts.session) {
      console.log(chalk.red("  --open and --github require --session <path>\n"));
      process.exit(1);
    }

    let sessionInfo: SessionInfo | undefined;
    let sessionPaths: string | string[];
    let providerName: string;

    if (opts.session) {
      sessionPaths = opts.session;
      providerName = opts.provider;
    } else {
      // ─── Top-level menu ─────────────────────────────────
      const topChoice = await select<"dashboard" | "sessions" | "replays">({
        message: "What would you like to do?",
        choices: [
          {
            name: `${chalk.bold.cyan("○")} ${chalk.bold("Dashboard")} ${chalk.dim("— browse, annotate, share & export all replays")} ${chalk.cyan("(recommended)")}`,
            value: "dashboard" as const,
          },
          {
            name: `${chalk.bold.green("○")} ${chalk.bold("New Replay")} ${chalk.dim("— pick a session and generate a replay")}`,
            value: "sessions" as const,
          },
          {
            name: `${chalk.bold.magenta("○")} ${chalk.bold("Open Replay")} ${chalk.dim("— quick-open an existing replay in browser")}`,
            value: "replays" as const,
          },
        ],
      });

      if (topChoice === "dashboard") {
        await startDashboard(replayBaseDir, getDevViewerOpts());
        return;
      }

      if (topChoice === "replays") {
        // List existing generated replays from ~/.vibe-replay/
        const { readdir, readFile } = await import("node:fs/promises");
        const replayEntries: { name: string; value: string; startTime: string }[] = [];
        try {
          const entries = await readdir(replayBaseDir);
          for (const slug of entries) {
            if (slug.startsWith(".") || slug === "cache") continue;
            try {
              const raw = await readFile(pathJoin(replayBaseDir, slug, "replay.json"), "utf-8");
              const replay = JSON.parse(raw);
              const title = replay.meta?.title || slug;
              const provider = replay.meta?.provider || "";
              const scenes = replay.meta?.stats?.sceneCount || 0;
              const startTime = replay.meta?.startTime || "";
              const time = startTime
                ? new Date(startTime).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })
                : "";
              const providerBadge =
                provider === "claude-code"
                  ? chalk.hex("#D97706")("claude")
                  : provider === "claude-desktop"
                    ? chalk.hex("#C084FC")("desktop")
                    : provider === "claude-cowork"
                      ? chalk.hex("#F472B6")("cowork")
                      : provider === "cursor"
                        ? chalk.hex("#0096FF")("cursor")
                        : provider === "codex"
                          ? chalk.hex("#B392F0")("codex")
                          : chalk.yellow(provider);
              replayEntries.push({
                name: `${providerBadge} ${chalk.dim(`[${time}]`)} ${chalk.white(title)} ${chalk.dim(`(${scenes} scenes)`)}`,
                value: slug,
                startTime,
              });
            } catch {
              // skip invalid entries
            }
          }
        } catch {
          // directory doesn't exist yet
        }

        if (replayEntries.length === 0) {
          console.log(chalk.yellow("\n  No replays found. Generate one first!\n"));
          process.exit(0);
        }

        // Sort by startTime descending (newest first)
        replayEntries.sort((a, b) => b.startTime.localeCompare(a.startTime));
        const replaySlug = await select<string>({
          message: "Pick a replay to open:",
          choices: replayEntries,
          pageSize: 20,
        });

        const htmlPath = pathJoin(replayBaseDir, replaySlug, "index.html");
        await publishLocal(htmlPath);
        console.log();
        console.log(chalk.bold.green("  ✓ Opened!"));
        console.log(chalk.dim("  File: ") + chalk.white(htmlPath));
        console.log();
        return;
      }

      // ─── Sessions: discover & pick ──────────────────────
      let displayedSessions: SessionInfo[] = [];
      const cached = await readFileCache<SessionInfo[]>(SESSION_DISCOVERY_CACHE_KEY);
      const hasStaleCache = !!(cached && cached.data.length > 0);

      if (hasStaleCache && cached) {
        displayedSessions = cached.data
          .slice()
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        // Silently refresh cache for next run
        discoverAllSessions()
          .then(async (freshSessions) => {
            await writeFileCache(SESSION_DISCOVERY_CACHE_KEY, freshSessions);
          })
          .catch(() => {});
      } else {
        const spinner = ora("Scanning sessions...").start();
        try {
          displayedSessions = await discoverAllSessions();
          await writeFileCache(SESSION_DISCOVERY_CACHE_KEY, displayedSessions);
        } finally {
          spinner.stop();
        }
      }

      if (displayedSessions.length === 0) {
        console.log(chalk.red("  No AI coding sessions found."));
        process.exit(1);
      }

      // Check for sessions approaching Claude Code's cleanup deadline
      const cleanupPeriodDays = await getClaudeCodeCleanupPeriod();
      const cleanupWarning = checkCleanupWarnings(displayedSessions, cleanupPeriodDays);
      if (cleanupWarning) {
        const daysText =
          cleanupWarning.soonestDays === 0
            ? "today"
            : cleanupWarning.soonestDays === 1
              ? "tomorrow"
              : `within ${cleanupWarning.soonestDays} days`;
        const countLabel = cleanupWarning.expiringCount === 1 ? "session" : "sessions";
        console.log();
        console.log(
          chalk.yellow(
            `  ⚠ ${cleanupWarning.expiringCount} ${countLabel} will be cleaned up ${daysText}`,
          ) + chalk.dim(` (cleanupPeriodDays: ${cleanupWarning.cleanupPeriodDays})`),
        );
        console.log(
          chalk.dim(
            "    Generate replays to preserve them, or increase cleanupPeriodDays in Claude Code settings",
          ),
        );
      }

      let chosen: string;

      const { emitKeypressEvents } = await import("node:readline");
      if (!process.stdin.listenerCount("keypress")) {
        emitKeypressEvents(process.stdin);
      }

      // Loop to support r=refresh shortcut
      while (true) {
        const choices = formatSessionChoices(displayedSessions, cleanupPeriodDays);
        const ac = new AbortController();
        let shouldRefresh = false;

        const onKeypress = (_str: string, key: { name?: string }) => {
          if (key?.name === "r") {
            shouldRefresh = true;
            ac.abort();
          }
        };
        process.stdin.on("keypress", onKeypress);
        ac.signal.addEventListener("abort", () => {
          process.stdin.off("keypress", onKeypress);
        });

        try {
          chosen = await select<string>(
            {
              message: "Pick a session to replay:",
              choices,
              pageSize: 20,
              theme: {
                style: {
                  keysHelpTip: (keys: [string, string][]) =>
                    [...keys, ["r", "refresh"]]
                      .map(([k, v]) => `${chalk.bold(k)} ${chalk.dim(v)}`)
                      .join(chalk.dim(" \u00b7 ")),
                },
              },
            },
            { signal: ac.signal },
          );
          process.stdin.off("keypress", onKeypress);
          break;
        } catch {
          process.stdin.off("keypress", onKeypress);
          if (shouldRefresh) {
            const spinner = ora("Refreshing sessions...").start();
            try {
              displayedSessions = await discoverAllSessions();
              await writeFileCache(SESSION_DISCOVERY_CACHE_KEY, displayedSessions);
              spinner.succeed(`Found ${displayedSessions.length} sessions`);
            } catch {
              spinner.fail("Refresh failed, using previous list");
            }
            continue;
          }
          process.exit(0);
        }
      }

      const info = displayedSessions.find((s) => s.filePath === chosen);
      sessionInfo = info;
      sessionPaths = info ? [...info.filePaths, ...(info.toolPaths || [])] : [chosen];
      providerName = info?.provider || opts.provider;
    }

    // Parse
    const provider = getProvider(providerName);
    if (!provider) {
      console.log(chalk.red(`  Unknown provider: ${providerName}`));
      process.exit(1);
    }

    const spinner = ora("Parsing session...").start();
    const home = (await import("node:os")).homedir();
    let parsed: Awaited<ReturnType<typeof provider.parse>>;
    let replay: ReturnType<typeof transformToReplay>;
    try {
      parsed = await provider.parse(sessionPaths, sessionInfo);
      spinner.text = "Transforming to replay...";

      const rawProject = sessionInfo?.project || parsed.cwd;
      const project = rawProject.startsWith(home)
        ? `~${rawProject.slice(home.length)}`
        : rawProject;
      replay = transformToReplay(parsed, providerName, project, {
        generator: {
          name: "vibe-replay",
          version: CLI_VERSION,
          generatedAt: new Date().toISOString(),
        },
      });

      const thinkingStr = replay.meta.stats.thinkingBlocks
        ? `, ${replay.meta.stats.thinkingBlocks} thinking`
        : "";
      const sourceStr = replay.meta.dataSource ? chalk.dim(` [${replay.meta.dataSource}]`) : "";
      spinner.succeed(
        `${replay.scenes.length} scenes (${replay.meta.stats.userPrompts} prompts, ${replay.meta.stats.toolCalls} tool calls${thinkingStr})${sourceStr}`,
      );
    } catch (err) {
      spinner.fail("Failed to parse session");
      throw err;
    }

    // Title: CLI flag > interactive prompt > auto-detected > slug
    if (opts.title) {
      const normalizedCliTitle = normalizeTitle(opts.title);
      if (normalizedCliTitle) replay.meta.title = normalizedCliTitle;
    } else if (opts.open || opts.github) {
      // Non-interactive: use auto-detected title
      const autoTitle = suggestedReplayTitle(replay.meta.title, replay.meta.slug, sessionInfo);
      replay.meta.title = autoTitle;
    } else {
      const { input } = await import("@inquirer/prompts");
      const defaultTitle = suggestedReplayTitle(replay.meta.title, replay.meta.slug, sessionInfo);
      const userTitle = await input({
        message: "Replay title (shown on landing page & shared links):",
        default: defaultTitle,
      });
      const normalizedUserTitle = normalizeTitle(userTitle);
      if (normalizedUserTitle) {
        replay.meta.title = normalizedUserTitle;
      }
    }

    // Common output path
    const { join } = await import("node:path");
    const rawSlug = replay.meta.slug || replay.meta.sessionId.slice(0, 8);
    const slug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-");
    const outputDir = join(home, ".vibe-replay", slug);

    const genSpinner = ora("Generating replay...").start();
    const outputPath = await generateOutput(replay, outputDir);
    const { stat: fsStat } = await import("node:fs/promises");
    const size = await fsStat(outputPath).then((s) => (s.size / 1024 / 1024).toFixed(1));
    genSpinner.succeed(`${outputPath} (${size} MB)`);

    // Second-layer leak detection: scan the serialized replay for secrets
    const scanSpinner = ora("Scanning for secrets...").start();
    const findings = scanForSecrets(JSON.stringify(replay));
    if (findings.length === 0) {
      scanSpinner.succeed("No secrets detected");
    } else {
      scanSpinner.warn(`${findings.length} potential secret(s) found`);
      console.log();
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i];
        console.log(chalk.yellow(`  ${i + 1}. [${f.rule}]`));
        console.log(chalk.dim(`     ${f.match}`));
      }
      console.log();

      if (opts.open || opts.github) {
        process.stderr.write(
          `${chalk.yellow("  ⚠ Non-interactive mode: continuing despite potential secrets. Review the output.")}\n\n`,
        );
      } else {
        const { confirm } = await import("@inquirer/prompts");
        const ok = await confirm({
          message: "These may be false alarms (e.g. example keys in docs). Continue anyway?",
          default: false,
        });
        if (!ok) {
          console.log(chalk.red("\n  Aborted — review the session and re-run.\n"));
          process.exit(1);
        }
        console.log(chalk.dim("  Continuing — user confirmed findings are safe.\n"));
      }
    }

    // --open: auto-open in browser and exit (non-interactive mode)
    if (opts.open) {
      await publishLocal(outputPath);
      console.log();
      console.log(chalk.bold.green("  ✓ Done!"));
      console.log(chalk.dim("  File: ") + chalk.white(outputPath));
      console.log();
      return;
    }

    // --github: generate GitHub export artifacts and exit (non-interactive)
    if (opts.github) {
      const result = await runGitHubExport(replay, outputDir);
      // Print the markdown to stdout for easy piping
      console.log();
      console.log(result.markdown);
      // Status messages go to stderr so they don't pollute piped output
      process.stderr.write(`\n${chalk.bold.green("  Done!")}\n`);
      process.stderr.write(`${chalk.dim("  Files: ")}${chalk.white(outputDir)}\n`);
      process.stderr.write(
        `${chalk.dim("  Redactions: ")}${chalk.white(result.redactionsPath)}\n\n`,
      );
      return;
    }

    // Check publish availability (requires vibe-replay auth login)
    const publishStatus = checkPublishStatus();
    const gistLabel = publishStatus.available
      ? `${chalk.blue("↑")} Publish to Gist now ${chalk.dim("(skip editor, publish directly)")}`
      : `${chalk.dim("↑ Publish to Gist now")} ${chalk.red("(login required)")}`;
    const isLoggedIn = !!loadAuthToken();
    const cloudLabel = isLoggedIn
      ? `${chalk.cyan("☁")} Share via Cloud ${chalk.dim("(7-day link, up to 10MB)")}`
      : `${chalk.dim("☁ Share via Cloud")} ${chalk.red("(login required)")}`;

    // Publish target
    console.log();
    const choices: {
      name: string;
      value: "local" | "editor" | "cloud" | "gist" | "github" | "exit";
    }[] = [
      {
        name: `${chalk.magenta("✎")} Open in Editor ${chalk.dim("(annotate, publish, export)")}`,
        value: "editor" as const,
      },
      {
        name: `${chalk.green("●")} Quick preview ${chalk.dim("(open HTML in browser, no editing)")}`,
        value: "local" as const,
      },
      { name: cloudLabel, value: "cloud" as const },
      { name: gistLabel, value: "gist" as const },
      {
        name: `${chalk.yellow("★")} Export for GitHub ${chalk.dim("(markdown + animated SVG for PRs)")}`,
        value: "github" as const,
      },
      { name: `${chalk.dim("✕")} Exit`, value: "exit" as const },
    ];

    const target = await select({
      message: "Replay is ready! How would you like to share it?",
      choices,
    });

    if (target === "local") {
      await publishLocal(outputPath);
    } else if (target === "editor") {
      await startServer(join(home, ".vibe-replay"), {
        openSlug: slug,
        ...getDevViewerOpts(),
      });
      return; // startServer blocks until Ctrl+C
    } else if (target === "cloud") {
      if (!isLoggedIn) {
        console.log();
        console.log(chalk.yellow("  Login required for cloud sharing."));
        console.log(chalk.dim("  Run → ") + chalk.white("vibe-replay auth login"));
      } else {
        const { confirm } = await import("@inquirer/prompts");
        const ok = await confirm({
          message: "Upload to vibe-replay cloud? (unlisted link, expires in 7 days)",
          default: true,
        });
        if (!ok) {
          console.log(chalk.dim("\n  Cloud share cancelled."));
        } else {
          const cloudSpinner = ora("Uploading to cloud...").start();
          try {
            const result = await publishCloudWithOverlays(outputDir);
            cloudSpinner.succeed("Uploaded!");
            console.log(chalk.dim("  Share URL: ") + chalk.cyan(result.url));
            console.log(
              chalk.dim("  Expires:   ") +
                chalk.white(new Date(result.expiresAt).toLocaleDateString()),
            );
          } catch (err: unknown) {
            cloudSpinner.fail(err instanceof Error ? err.message : String(err));
          }
        }
      }
    } else if (target === "gist") {
      if (!publishStatus.available) {
        console.log();
        console.log(chalk.yellow("  Login required to publish gists."));
        console.log(chalk.dim("  Run → ") + chalk.white("vibe-replay auth login"));
      } else {
        const { confirm } = await import("@inquirer/prompts");
        const ok = await confirm({
          message: "This will create a public Gist visible to anyone on the internet. Continue?",
          default: true,
        });
        if (!ok) {
          console.log(chalk.dim("\n  Gist publish cancelled."));
        } else {
          const title = replay.meta.title || slug;
          const savedGist = await loadSavedGistInfo(outputDir);
          let shouldPublish = true;
          let overwriteGist: SavedGistInfo | undefined;
          if (savedGist) {
            const publishMode = await select<"overwrite" | "create" | "cancel">({
              message: `Previous gist found (${savedGist.gistId}). How to publish this replay?`,
              choices: [
                { name: `${chalk.cyan("↻")} Overwrite previous gist`, value: "overwrite" },
                { name: `${chalk.green("+")} Create a new gist`, value: "create" },
                { name: `${chalk.dim("✕")} Cancel`, value: "cancel" },
              ],
            });
            if (publishMode === "cancel") {
              console.log(chalk.dim("\n  Gist publish cancelled."));
              shouldPublish = false;
            } else {
              overwriteGist = publishMode === "overwrite" ? savedGist : undefined;
            }
          }
          if (shouldPublish) {
            const gistSpinner = ora("Publishing to Gist...").start();
            try {
              const result = await publishGist(outputDir, title, {
                overwrite: overwriteGist,
              });
              gistSpinner.succeed(result.mode === "updated" ? "Gist updated!" : "Published!");
              console.log(chalk.dim("  Gist:   ") + chalk.white(result.gistUrl));
              console.log(chalk.dim("  Viewer: ") + chalk.cyan(result.viewerUrl));
            } catch (err: unknown) {
              gistSpinner.fail(err instanceof Error ? err.message : String(err));
            }
          }
        }
      }
    } else if (target === "github") {
      const result = await runGitHubExport(replay, outputDir);
      console.log();
      console.log(chalk.dim("  ─── Preview ───"));
      console.log();
      console.log(result.markdown);
      console.log();
      console.log(chalk.bold.green("  Done!"));
      console.log(chalk.dim("  Files: ") + chalk.white(outputDir));
      console.log(chalk.dim("  Redactions: ") + chalk.white(result.redactionsPath));
      console.log(
        chalk.dim("  Tip: ") +
          chalk.white(
            "Copy session-preview.gif to your repo, then paste the markdown into your PR",
          ),
      );
      console.log();
      return;
    }

    // Final summary
    console.log();
    console.log(chalk.bold.green("  ✓ Done!"));
    console.log(chalk.dim("  File: ") + chalk.white(outputPath));
    console.log();
  });

// ---------------------------------------------------------------------------
// Auth command group — login, logout, status
// ---------------------------------------------------------------------------

const authCmd = program.command("auth").description("Manage authentication");

authCmd
  .command("login")
  .description("Log in to vibe-replay with GitHub")
  .option("--api-url <url>", "API base URL", "https://vibe-replay.com")
  .action(async (opts) => {
    const crypto = await import("node:crypto");
    const apiUrl = opts.apiUrl.replace(/\/$/, "");

    // Only allow official domain or localhost to prevent phishing via crafted --api-url
    const parsed = new URL(apiUrl);
    if (
      parsed.hostname !== "vibe-replay.com" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      console.error(chalk.red(`\n  ✗ Untrusted API URL: ${apiUrl}`));
      console.error(chalk.dim("  Only https://vibe-replay.com and localhost are allowed.\n"));
      process.exit(1);
    }

    const nonce = crypto.randomUUID();

    // Start a localhost callback server on a random port
    const server = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": apiUrl,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) {
            res.writeHead(413);
            res.end();
            req.destroy();
            return;
          }
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.nonce !== nonce) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end("Forbidden");
              console.error(chalk.red("\n  ✗ Rejected callback with invalid nonce\n"));
              return;
            }
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": apiUrl,
          });
          res.end("OK");

          try {
            const data = JSON.parse(body);
            saveAuthTokenSync({ token: data.token, user: data.user }, apiUrl);
            console.log(
              chalk.bold.green("\n  ✓ Logged in as ") +
                chalk.white(data.user?.name || data.user?.email),
            );
            console.log(chalk.dim(`  Token saved to ${getAuthFilePath()} [${apiUrl}]\n`));
          } catch (err) {
            console.error(chalk.red("\n  ✗ Failed to save auth token"));
            console.error(chalk.dim(`  Body received: ${body.slice(0, 200)}`));
            console.error(chalk.dim(`  Error: ${err}\n`));
          }
          server.close();
          process.exit(0);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const loginUrl = `${apiUrl}/auth/cli-login?port=${addr.port}&nonce=${nonce}`;
      console.log(chalk.bold.cyan("\n  vibe-replay auth login\n"));
      console.log(chalk.dim("  Opening browser to authenticate with GitHub..."));
      console.log(chalk.dim(`  If it doesn't open, visit: ${loginUrl}\n`));

      // Open browser
      import("open")
        .then((m) => m.default(loginUrl))
        .catch(() => {
          // open package not available, user can manually open
        });
    });

    // Timeout after 5 minutes
    setTimeout(
      () => {
        console.error(chalk.red("\n  ✗ Login timed out after 5 minutes\n"));
        server.close();
        process.exit(1);
      },
      5 * 60 * 1000,
    );
  });

authCmd
  .command("logout")
  .description("Log out of vibe-replay")
  .option("--api-url <url>", "API base URL", "https://vibe-replay.com")
  .action(async (opts) => {
    const apiUrl = opts.apiUrl.replace(/\/$/, "");
    const auth = loadAuthToken(apiUrl);
    if (!auth) {
      console.log(chalk.dim("\n  Not logged in.\n"));
      return;
    }

    removeAuthTokenSync(apiUrl);
    console.log(chalk.bold.green("\n  ✓ Logged out successfully\n"));
  });

authCmd
  .command("status")
  .description("Show current authentication status")
  .option("--api-url <url>", "API base URL", "https://vibe-replay.com")
  .action(async (opts) => {
    const apiUrl = opts.apiUrl.replace(/\/$/, "");
    const auth = loadAuthToken(apiUrl);

    if (!auth) {
      console.log(chalk.dim("\n  Not logged in."));
      console.log(
        chalk.dim("  Run ") +
          chalk.white("vibe-replay auth login") +
          chalk.dim(" to authenticate.\n"),
      );
      return;
    }

    console.log(chalk.bold.cyan("\n  vibe-replay auth status\n"));
    console.log(
      chalk.dim("  Logged in as ") + chalk.white(auth.user?.name || auth.user?.email || "unknown"),
    );
    if (auth.user?.image) {
      console.log(chalk.dim("  Avatar:    ") + chalk.white(auth.user.image));
    }
    console.log(chalk.dim("  API:       ") + chalk.white(apiUrl));
    console.log(chalk.dim("  Auth file: ") + chalk.white(getAuthFilePath()));
    console.log();
  });

// ---------------------------------------------------------------------------
// share — upload an existing replay to the cloud
// ---------------------------------------------------------------------------

const VISIBILITIES = ["public", "unlisted", "private"] as const;
type Visibility = (typeof VISIBILITIES)[number];

program
  .command("share")
  .description("Share an existing replay via cloud (unlisted link, expires in 7 days)")
  .argument("[path]", "Path to replay directory or replay.json")
  .option("--visibility <type>", `Visibility: ${VISIBILITIES.join(", ")}`, "unlisted")
  .option("--api-url <url>", `API base URL (default: ${DEFAULT_API_URL})`)
  .action(async (pathArg: string | undefined, opts: { visibility: string; apiUrl?: string }) => {
    const { existsSync, statSync } = await import("node:fs");
    const { readFile, readdir } = await import("node:fs/promises");
    const { join, dirname, resolve } = await import("node:path");
    const { homedir } = await import("node:os");

    // Honor --api-url whenever the user supplies it, even when the value
    // matches DEFAULT_API_URL (overriding a preset shell env var).
    // Without the flag, fall through to existing precedence: env > DEFAULT_API_URL.
    if (opts.apiUrl) {
      process.env.VIBE_REPLAY_API_URL = opts.apiUrl.replace(/\/$/, "");
    }

    // Validate raw string before narrowing the type.
    if (!(VISIBILITIES as readonly string[]).includes(opts.visibility)) {
      console.error(chalk.red(`\n  ✗ Invalid --visibility: ${opts.visibility}`));
      console.error(chalk.dim(`  Must be one of: ${VISIBILITIES.join(", ")}\n`));
      process.exit(1);
    }
    const visibility = opts.visibility as Visibility;

    // Pre-flight auth check — fail fast before any picker / I/O / spinner.
    if (!loadAuthToken()) {
      console.error(chalk.red("\n  ✗ Not logged in."));
      console.error(chalk.dim("  Run → ") + chalk.white("vibe-replay auth login\n"));
      process.exit(1);
    }

    let outputDir: string;

    if (pathArg) {
      const abs = resolve(pathArg);
      if (!existsSync(abs)) {
        console.error(chalk.red(`\n  ✗ Path not found: ${abs}\n`));
        process.exit(1);
      }
      const s = statSync(abs);
      outputDir = s.isDirectory() ? abs : dirname(abs);
    } else {
      const replayBaseDir = join(homedir(), ".vibe-replay");
      const entries = await readdir(replayBaseDir).catch(() => [] as string[]);
      const replays: { name: string; value: string; time: string }[] = [];

      for (const slug of entries) {
        if (slug.startsWith(".") || slug === "cache") continue;
        const jsonPath = join(replayBaseDir, slug, "replay.json");
        try {
          const raw = await readFile(jsonPath, "utf-8");
          const replay = JSON.parse(raw) as ReplaySession;
          const title = replay.meta?.title || slug;
          const startTime = replay.meta?.startTime || "";
          const time = startTime
            ? new Date(startTime).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : "";
          replays.push({
            name: time ? `${chalk.dim(`[${time}]`)} ${chalk.white(title)}` : chalk.white(title),
            value: join(replayBaseDir, slug),
            time: startTime,
          });
        } catch {
          // skip slugs without a valid replay.json
        }
      }

      if (replays.length === 0) {
        console.log(chalk.yellow("\n  No replays found. Generate one first!\n"));
        process.exit(1);
      }

      replays.sort((a, b) => b.time.localeCompare(a.time));
      outputDir = await select({
        message: "Pick a replay to share:",
        choices: replays,
      });
    }

    const jsonPath = join(outputDir, "replay.json");
    if (!existsSync(jsonPath)) {
      console.error(chalk.red(`\n  ✗ No replay.json found in ${outputDir}\n`));
      process.exit(1);
    }

    const spinner = ora("Uploading to cloud...").start();
    try {
      const result = await publishCloudWithOverlays(outputDir, { visibility });
      spinner.succeed("Uploaded!");
      console.log();
      console.log(chalk.dim("  Share URL: ") + chalk.cyan(result.url));
      console.log(
        chalk.dim("  Expires:   ") + chalk.white(new Date(result.expiresAt).toLocaleDateString()),
      );
      console.log();
    } catch (err: unknown) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// live — open the dashboard streaming a currently-active session
// ---------------------------------------------------------------------------

// If the most-recent session was last touched more than this long ago, warn
// the user — the source process is probably no longer running, so the live
// stream will sit idle until they kick off a new turn.
const LIVE_STALENESS_WARNING_MS = 5 * 60_000;

program
  .command("live")
  .description("Watch a running AI coding session live in the browser")
  .option("-p, --provider <name>", "Provider name (default: auto-detect)")
  .option("-s, --session <sessionId>", "Specific session ID to watch")
  .action(async (opts: { provider?: string; session?: string }) => {
    if (process.platform === "win32") {
      console.log(chalk.yellow("\n  ⚠ Windows is not supported yet.\n"));
      process.exit(1);
    }

    const { join: pathJoin } = await import("node:path");
    const { homedir } = await import("node:os");
    const replayBaseDir = pathJoin(homedir(), ".vibe-replay");

    console.log(chalk.bold.cyan("\n  vibe-replay live") + chalk.dim(` v${CLI_VERSION}\n`));

    let target: { provider: string; sessionId: string; title?: string } | null = null;

    if (opts.session) {
      // Explicit session id — find which provider owns it
      const providerHint = opts.provider;
      const providers = providerHint
        ? [getProvider(providerHint)].filter((p): p is NonNullable<typeof p> => !!p)
        : getAllProviders();
      for (const provider of providers) {
        try {
          const sessions = await provider.discover();
          const match = sessions.find((s) => s.sessionId === opts.session);
          if (match) {
            target = { provider: match.provider, sessionId: match.sessionId, title: match.title };
            break;
          }
        } catch {
          // best-effort across providers
        }
      }
      if (!target) {
        console.log(chalk.red(`  ✗ Session not found: ${opts.session}\n`));
        process.exit(1);
      }
    } else {
      // Auto-pick most-recently-active session across providers
      const ora = (await import("ora")).default;
      const spinner = ora("Finding the most recent session...").start();
      const all: SessionInfo[] = [];
      const providers = opts.provider
        ? [getProvider(opts.provider)].filter((p): p is NonNullable<typeof p> => !!p)
        : getAllProviders();
      for (const provider of providers) {
        try {
          const sessions = await provider.discover();
          all.push(...sessions);
        } catch {
          // best-effort
        }
      }
      if (all.length === 0) {
        spinner.fail("No AI coding sessions found");
        console.log(chalk.dim("  Start a Claude Code or Cursor session, then run again.\n"));
        process.exit(1);
      }
      all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const top = all[0]!;
      target = { provider: top.provider, sessionId: top.sessionId, title: top.title };
      const ageMs = Date.now() - new Date(top.timestamp).getTime();
      const ageLabel =
        ageMs < 60_000
          ? `${Math.max(1, Math.round(ageMs / 1000))}s ago`
          : ageMs < 3_600_000
            ? `${Math.round(ageMs / 60_000)}m ago`
            : `${Math.round(ageMs / 3_600_000)}h ago`;
      spinner.succeed(`${top.title || top.sessionId.slice(0, 8)} (${top.provider}, ${ageLabel})`);
      if (ageMs > LIVE_STALENESS_WARNING_MS) {
        console.log(
          chalk.yellow(
            `  ⚠ Last activity was ${ageLabel} — the session may not be running anymore.`,
          ),
        );
        console.log(chalk.dim("    The viewer will still update if Claude writes new turns.\n"));
      }
    }

    await startServer(replayBaseDir, {
      openLive: { provider: target.provider, sessionId: target.sessionId },
    });
  });

// Keep backwards-compatible hidden alias
program
  .command("login", { hidden: true })
  .description("Log in to vibe-replay (alias for auth login)")
  .option("--api-url <url>", "API base URL", "https://vibe-replay.com")
  .action(async () => {
    // Delegate to auth login
    await authCmd.commands
      .find((c) => c.name() === "login")
      ?.parseAsync(["login", ...process.argv.slice(3)], { from: "user" });
  });

program.parse();

function formatSessionChoices(sessions: SessionInfo[], cleanupPeriodDays?: number) {
  // Merge sessions with the same slug under the same project
  const merged = mergeSameSessions(sessions);

  // Group by project
  const byProject = new Map<string, SessionInfo[]>();
  for (const s of merged) {
    const key = s.project;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(s);
  }

  const choices: any[] = [];
  const projectEntries = [...byProject.entries()];

  for (let pi = 0; pi < projectEntries.length; pi++) {
    const [project, projectSessions] = projectEntries[pi];

    // Prominent separator between projects
    if (pi > 0) choices.push(new Separator(""));
    choices.push(new Separator(chalk.bold.white(`  ─── ${project} ───`)));

    for (const s of projectSessions) {
      const date = new Date(s.timestamp);
      const timeStr = date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const sizeKB = Math.round(s.fileSize / 1024);
      const prompt = s.firstPrompt.replace(/\n/g, " ").slice(0, 50);

      // Claude: orange-brown (#D97706), Desktop: purple (#C084FC),
      // Cowork: pink (#F472B6), Cursor: blue (#0096FF), Codex: purple (#B392F0)
      const providerBadge =
        s.provider === "claude-code"
          ? chalk.hex("#D97706")("claude")
          : s.provider === "claude-desktop"
            ? chalk.hex("#C084FC")("desktop")
            : s.provider === "claude-cowork"
              ? chalk.hex("#F472B6")("cowork")
              : s.provider === "cursor"
                ? chalk.hex("#0096FF")("cursor")
                : s.provider === "codex"
                  ? chalk.hex("#B392F0")("codex")
                  : chalk.yellow(s.provider);

      const titleStr = s.title ? chalk.white(` "${s.title}"`) : "";

      const fileCount = s.filePaths.length > 1 ? chalk.dim(` [${s.filePaths.length} parts]`) : "";
      const sqliteBadge = s.hasSqlite ? chalk.green(" db") : "";

      // Cleanup expiry badge for Claude Code / Desktop sessions (both share the same JSONL files)
      let expiryBadge = "";
      if (cleanupPeriodDays && (s.provider === "claude-code" || s.provider === "claude-desktop")) {
        const daysLeft = computeDaysUntilCleanup(s.timestamp, cleanupPeriodDays);
        if (daysLeft != null && daysLeft <= WARNING_THRESHOLD_DAYS) {
          const label = daysLeft === 0 ? "today" : `${daysLeft}d`;
          expiryBadge = daysLeft <= 2 ? chalk.red(` ⚠ ${label}`) : chalk.yellow(` ⚠ ${label}`);
        }
      }

      const line = [
        providerBadge,
        chalk.dim(`[${timeStr}]`),
        chalk.cyan(s.slug) + sqliteBadge + expiryBadge,
        titleStr,
        fileCount,
        chalk.dim("—"),
        chalk.dim(`"${prompt}..."`),
        chalk.dim(
          `(${s.lineCount}L, ${sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)}MB` : `${sizeKB}KB`})`,
        ),
      ].join(" ");

      choices.push({ name: line, value: s.filePath });
    }
  }

  return choices;
}

/**
 * Merge multiple JSONL files that share the same slug + project into one entry.
 * Claude Code creates a new file per /resume, but they're the same logical session.
 * We keep the most recent file as the representative and sum up the stats.
 */
function mergeSameSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();

  for (const s of sessions) {
    const key = `${s.project}::${s.slug}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(s);
  }

  const result: SessionInfo[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Sort by timestamp descending — pick the latest as representative
    group.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latest = group[0];

    // Collect all file paths sorted by timestamp ascending (chronological order)
    const allPaths = group
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .flatMap((s) => s.filePaths);

    const promptCount = group.some((s) => s.promptCount != null)
      ? group.reduce((sum, s) => sum + (s.promptCount || 0), 0)
      : undefined;
    const toolCallCount = group.some((s) => s.toolCallCount != null)
      ? group.reduce((sum, s) => sum + (s.toolCallCount || 0), 0)
      : undefined;

    result.push({
      ...latest,
      lineCount: group.reduce((sum, s) => sum + s.lineCount, 0),
      fileSize: group.reduce((sum, s) => sum + s.fileSize, 0),
      filePaths: allPaths,
      toolPaths: [...new Set(group.flatMap((s) => s.toolPaths || []))],
      promptCount,
      toolCallCount,
    });
  }

  // Re-sort by timestamp descending
  result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return result;
}
