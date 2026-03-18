import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { Separator, select } from "@inquirer/prompts";
import chalk from "chalk";
import { program } from "commander";
import ora from "ora";
import { readFileCache, writeFileCache } from "./cache.js";
import { cleanPromptText } from "./clean-prompt.js";
import { generateGitHubGif } from "./formatters/gif.js";
import { generateGitHubMarkdown, generateGitHubSvg } from "./formatters/github.js";
import { generateOutput } from "./generator.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import { checkPublishStatus, loadSavedGistInfo, publishGist } from "./publishers/gist.js";
import { publishLocal } from "./publishers/local.js";
import { scanForSecrets } from "./scan.js";
import { startDashboard, startServer } from "./server.js";
import { transformToReplay } from "./transform.js";
import type { SessionInfo } from "./types.js";
import { CLI_VERSION } from "./version.js";

const DEV_MENU_ENABLED = process.env.VIBE_REPLAY_DEV_MENU === "1";
const SESSION_DISCOVERY_CACHE_KEY = "session-discovery-v1";
const TITLE_MAX_CHARS = 120;

function normalizeTitle(value?: string): string {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}

function normalizePromptTitle(value?: string): string {
  return normalizeTitle(cleanPromptText(value || ""));
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

  return replayCandidate || slug;
}

async function discoverAllSessions(): Promise<SessionInfo[]> {
  const providers = getAllProviders();
  const allSessions: SessionInfo[] = [];
  for (const provider of providers) {
    const sessions = await provider.discover();
    allSessions.push(...sessions);
  }
  allSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allSessions;
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
      await startDashboard(
        replayBaseDir,
        DEV_MENU_ENABLED
          ? { externalViewerUrl: `http://localhost:${process.env.VIBE_VIEWER_PORT || "5173"}` }
          : undefined,
      );
      return;
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
        await startDashboard(
          replayBaseDir,
          DEV_MENU_ENABLED
            ? { externalViewerUrl: `http://localhost:${process.env.VIBE_VIEWER_PORT || "5173"}` }
            : undefined,
        );
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
                  : provider === "cursor"
                    ? chalk.hex("#0096FF")("cursor")
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

      let chosen: string;

      const { emitKeypressEvents } = await import("node:readline");
      if (!process.stdin.listenerCount("keypress")) {
        emitKeypressEvents(process.stdin);
      }

      // Loop to support r=refresh shortcut
      while (true) {
        const choices = formatSessionChoices(displayedSessions);
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

    // Check publish availability (requires vibe-replay auth login)
    const publishStatus = checkPublishStatus();
    const gistLabel = publishStatus.available
      ? `${chalk.blue("↑")} Publish to Gist now ${chalk.dim("(skip editor, publish directly)")}`
      : `${chalk.dim("↑ Publish to Gist now")} ${chalk.red("(login required)")}`;

    // Publish target
    console.log();
    const choices: {
      name: string;
      value: "local" | "editor" | "gist" | "github" | "exit";
    }[] = [
      {
        name: `${chalk.magenta("✎")} Open in Editor ${chalk.dim("(annotate, publish, export)")}`,
        value: "editor" as const,
      },
      {
        name: `${chalk.green("●")} Quick preview ${chalk.dim("(open HTML in browser, no editing)")}`,
        value: "local" as const,
      },
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
        externalViewerUrl: DEV_MENU_ENABLED
          ? `http://localhost:${process.env.VIBE_VIEWER_PORT || "5173"}`
          : undefined,
      });
      return; // startServer blocks until Ctrl+C
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
          let overwriteGist: string | undefined;
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
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(outputDir, { recursive: true });

      // Auto-detect replay URL from previously published gist
      const savedGist = await loadSavedGistInfo(outputDir);
      const replayUrl = savedGist?.viewerUrl;

      // Generate animated SVG
      const svgSpinner2 = ora("Generating animated SVG...").start();
      const svgContent = generateGitHubSvg(replay, { replayUrl });
      const svgFilePath = join(outputDir, "session-preview.svg");
      await writeFile(svgFilePath, svgContent, "utf-8");
      svgSpinner2.succeed(`SVG: ${svgFilePath}`);

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
        gifSpinner.fail(
          `GIF generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

      // Print preview
      console.log();
      console.log(chalk.dim("  ─── Preview ───"));
      console.log();
      console.log(markdown);
      console.log();
      console.log(chalk.bold.green("  Done!"));
      console.log(chalk.dim("  Files: ") + chalk.white(outputDir));
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

const AUTH_PATH = nodePath.join(os.homedir(), ".config", "vibe-replay", "auth.json");

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
            const configDir = nodePath.join(os.homedir(), ".config", "vibe-replay");
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
            const authPath = nodePath.join(configDir, "auth.json");
            fs.writeFileSync(authPath, JSON.stringify(data, null, 2), {
              mode: 0o600,
            });
            console.log(
              chalk.bold.green("\n  ✓ Logged in as ") +
                chalk.white(data.user?.name || data.user?.email),
            );
            console.log(chalk.dim(`  Token saved to ${authPath}\n`));
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
  .action(async () => {
    const authPath = AUTH_PATH;

    if (!fs.existsSync(authPath)) {
      console.log(chalk.dim("\n  Not logged in.\n"));
      return;
    }

    fs.rmSync(authPath);
    console.log(chalk.bold.green("\n  ✓ Logged out successfully\n"));
  });

authCmd
  .command("status")
  .description("Show current authentication status")
  .action(async () => {
    const authPath = AUTH_PATH;

    if (!fs.existsSync(authPath)) {
      console.log(chalk.dim("\n  Not logged in."));
      console.log(
        chalk.dim("  Run ") +
          chalk.white("vibe-replay auth login") +
          chalk.dim(" to authenticate.\n"),
      );
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      console.log(chalk.bold.cyan("\n  vibe-replay auth status\n"));
      console.log(
        chalk.dim("  Logged in as ") +
          chalk.white(data.user?.name || data.user?.email || "unknown"),
      );
      if (data.user?.image) {
        console.log(chalk.dim("  Avatar:    ") + chalk.white(data.user.image));
      }
      console.log(chalk.dim("  Auth file: ") + chalk.white(authPath));
      console.log();
    } catch {
      console.error(chalk.red("\n  ✗ Failed to read auth file"));
      console.error(chalk.dim(`  Path: ${authPath}\n`));
    }
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

function formatSessionChoices(sessions: SessionInfo[]) {
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

      // Claude: orange-brown (#D97706), Cursor: blue (#0096FF)
      const providerBadge =
        s.provider === "claude-code"
          ? chalk.hex("#D97706")("claude")
          : s.provider === "cursor"
            ? chalk.hex("#0096FF")("cursor")
            : chalk.yellow(s.provider);

      const titleStr = s.title ? chalk.white(` "${s.title}"`) : "";

      const fileCount = s.filePaths.length > 1 ? chalk.dim(` [${s.filePaths.length} parts]`) : "";
      const sqliteBadge = s.hasSqlite ? chalk.green(" db") : "";
      const line = [
        providerBadge,
        chalk.dim(`[${timeStr}]`),
        chalk.cyan(s.slug) + sqliteBadge,
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
