import { program } from "commander";
import { select, Separator } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { getAllProviders, getProvider } from "./providers/index.js";
import { transformToReplay } from "./transform.js";
import { generateOutput, generateDevJson } from "./generator.js";
import { publishLocal } from "./publishers/local.js";
import { publishGist, checkGhStatus } from "./publishers/gist.js";
import type { SessionInfo } from "./types.js";

program
  .name("vibe-replay")
  .description("AI Coding Session Replay & Sharing Tool")
  .version("0.1.0")
  .option("-s, --session <path>", "Path to a specific JSONL session file")
  .option("-p, --provider <name>", "Provider name (default: claude-code)", "claude-code")
  .option("--dev", "Write demo.json to viewer public/ for HMR development")
  .action(async (opts) => {
    console.log(chalk.bold.cyan("\n  vibe-replay") + chalk.dim(" v0.1.0\n"));

    let sessionInfo: SessionInfo | undefined;
    let sessionPaths: string | string[];
    let providerName: string;

    if (opts.session) {
      sessionPaths = opts.session;
      providerName = opts.provider;
    } else {
      // Discover sessions from all providers
      const spinner = ora("Scanning sessions...").start();
      const providers = getAllProviders();
      const allSessions: SessionInfo[] = [];

      for (const provider of providers) {
        const sessions = await provider.discover();
        allSessions.push(...sessions);
      }

      // Sort by timestamp descending
      allSessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      spinner.stop();

      if (allSessions.length === 0) {
        console.log(chalk.red("  No AI coding sessions found."));
        process.exit(1);
      }

      // Group by project for display
      const choices = formatSessionChoices(allSessions);

      const chosen = await select<string>({
        message: "Pick a session to replay:",
        choices,
        pageSize: 20,
      });

      const info = allSessions.find((s) => s.filePath === chosen);
      sessionInfo = info;
      sessionPaths = info?.filePaths || [chosen];
      providerName = info?.provider || opts.provider;
    }

    // Parse
    const provider = getProvider(providerName);
    if (!provider) {
      console.log(chalk.red(`  Unknown provider: ${providerName}`));
      process.exit(1);
    }

    const spinner = ora("Parsing session...").start();
    const parsed = await provider.parse(sessionPaths);
    spinner.text = "Transforming to replay...";

    const rawProject = sessionInfo?.project || parsed.cwd;
    const home = (await import("node:os")).homedir();
    const project = rawProject.startsWith(home)
      ? "~" + rawProject.slice(home.length)
      : rawProject;
    const replay = transformToReplay(parsed, providerName, project);
    spinner.succeed(
      `${replay.scenes.length} scenes (${replay.meta.stats.userPrompts} prompts, ${replay.meta.stats.toolCalls} tool calls)`,
    );

    // Dev mode: write demo.json to viewer public/ and exit
    if (opts.dev) {
      const viewerPublic = new URL("../../viewer/public", import.meta.url).pathname;
      const devPath = await generateDevJson(replay, viewerPublic);
      console.log(chalk.green(`\n  Dev JSON written to ${devPath}`));
      console.log(chalk.dim("  Open viewer dev server: ") + chalk.white("cd packages/viewer && pnpm dev"));
      console.log(chalk.dim("  Then visit: ") + chalk.white("http://localhost:5173/?file=/demo.json\n"));
      return;
    }

    // Output path: vibe-replay/<slug>/index.html
    const rawSlug = replay.meta.slug || replay.meta.sessionId.slice(0, 8);
    const slug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, "-");
    const outputDir = `./vibe-replay/${slug}`;

    const genSpinner = ora("Generating replay...").start();
    const outputPath = await generateOutput(replay, outputDir);
    const { stat: fsStat } = await import("node:fs/promises");
    const size = await fsStat(outputPath).then((s) => (s.size / 1024 / 1024).toFixed(1));
    genSpinner.succeed(`${outputPath} (${size} MB)`);

    // Check gh availability for gist option
    const ghStatus = await checkGhStatus();
    const gistLabel = ghStatus.available
      ? `${chalk.blue("↑")} Publish to GitHub Gist ${chalk.yellow("(public — anyone with the link can view)")}`
      : ghStatus.reason === "not-installed"
        ? `${chalk.dim("↑ Publish to GitHub Gist")} ${chalk.dim("(requires gh CLI)")}`
        : `${chalk.dim("↑ Publish to GitHub Gist")} ${chalk.dim("(gh not logged in)")}`;

    // Publish target
    console.log();
    const target = await select({
      message: "Replay is ready! How would you like to share it?",
      choices: [
        { name: `${chalk.green("▶")} Open in browser`, value: "local" },
        { name: gistLabel, value: "gist" },
        { name: `${chalk.dim("✕")} Exit`, value: "exit" },
      ],
    });

    if (target === "local") {
      await publishLocal(outputPath);
    } else if (target === "gist") {
      if (!ghStatus.available) {
        if (ghStatus.reason === "not-installed") {
          console.log();
          console.log(chalk.yellow("  GitHub CLI (gh) is required to publish gists."));
          console.log(chalk.dim("  Install → ") + chalk.white("https://cli.github.com/"));
          console.log(chalk.dim("  Then run → ") + chalk.white("gh auth login"));
        } else {
          console.log();
          console.log(chalk.yellow("  GitHub CLI is installed but not logged in."));
          console.log(chalk.dim("  Run → ") + chalk.white("gh auth login"));
        }
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
          const gistSpinner = ora("Publishing to Gist...").start();
          try {
            const result = await publishGist(outputDir, title);
            gistSpinner.succeed("Published!");
            console.log(chalk.dim("  Gist:   ") + chalk.white(result.gistUrl));
            console.log(chalk.dim("  Viewer: ") + chalk.cyan(result.viewerUrl));
          } catch (err: any) {
            gistSpinner.fail(err.message);
          }
        }
      }
    }

    // Final summary
    console.log();
    console.log(chalk.bold.green("  ✓ Done!"));
    console.log(chalk.dim("  File: ") + chalk.white(outputPath));
    console.log();
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
    byProject.get(key)!.push(s);
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
      const providerBadge = s.provider === "claude-code"
        ? chalk.hex("#D97706")("claude")
        : s.provider === "cursor"
        ? chalk.hex("#0096FF")("cursor")
        : chalk.yellow(s.provider);

      const titleStr = s.title
        ? chalk.white(` "${s.title}"`)
        : "";

      const fileCount = s.filePaths.length > 1 ? chalk.dim(` [${s.filePaths.length} parts]`) : "";
      const line = [
        providerBadge,
        chalk.dim(`[${timeStr}]`),
        chalk.cyan(s.slug),
        titleStr,
        fileCount,
        chalk.dim("—"),
        chalk.dim(`"${prompt}..."`),
        chalk.dim(`(${s.lineCount}L, ${sizeKB >= 1024 ? (sizeKB / 1024).toFixed(1) + "MB" : sizeKB + "KB"})`),
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
    groups.get(key)!.push(s);
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

    result.push({
      ...latest,
      lineCount: group.reduce((sum, s) => sum + s.lineCount, 0),
      fileSize: group.reduce((sum, s) => sum + s.fileSize, 0),
      filePaths: allPaths,
    });
  }

  // Re-sort by timestamp descending
  result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return result;
}
