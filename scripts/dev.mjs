#!/usr/bin/env node
/**
 * Dev launcher — finds free ports for both Vite (viewer) and the CLI API server,
 * so multiple `pnpm dev` sessions can run simultaneously without conflicts.
 *
 * Usage:
 *   node scripts/dev.mjs            # dashboard-first dev (default)
 *   node scripts/dev.mjs -d         # explicit dashboard mode (same as default)
 *   node scripts/dev.mjs --menu     # interactive CLI menu mode
 */
import { watch } from "node:fs";
import {
  readPortOverride,
  killProcessTree,
  reserveFreePort,
  reservePort,
  spawnPnpm,
  spawnTsx,
  waitForProcessTree,
  waitForPortBound,
  viewerLogPath,
} from "./dev-utils.mjs";

const VITE_PREFERRED = 5173;
const API_PREFERRED = 13456;

const forceDashboard = process.argv.includes("-d");
const menuMode = process.argv.includes("--menu");
const dashboardMode = forceDashboard || !menuMode;

const apiPortOverride = readPortOverride(["VIBE_API_PORT", "VITE_API_PORT"], "API port");
const vitePortOverride = readPortOverride(["VIBE_VIEWER_PORT", "VITE_PORT"], "Viewer port");
if (apiPortOverride !== undefined && apiPortOverride === vitePortOverride) {
  throw new Error(`API port and viewer port must be different (both are ${apiPortOverride})`);
}

// Keep reservations for the entire launcher lifetime. A free-port probe alone
// has a check-then-bind race when two worktrees start at the same time; the
// lock prevents another launcher from selecting the same port during startup
// and during CLI HMR restarts.
const reservations = [];
let apiReservation;
let viteReservation;
let vite;
let cli;

try {
  apiReservation =
    apiPortOverride !== undefined
      ? await reservePort(apiPortOverride, "API port")
      : await reserveFreePort(API_PREFERRED);
  reservations.push(apiReservation);

  viteReservation =
    vitePortOverride !== undefined
      ? await reservePort(vitePortOverride, "Viewer port")
      : await reserveFreePort(VITE_PREFERRED);
  reservations.push(viteReservation);
} catch (error) {
  await Promise.all(reservations.map(({ release }) => release()));
  throw error;
}

const apiPort = apiReservation.port;
const vitePort = viteReservation.port;

console.log();
console.log(
  `[vibe-replay] API port:    ${apiPort}${apiPort !== API_PREFERRED ? ` (${API_PREFERRED} was busy)` : ""}`,
);
console.log(
  `[vibe-replay] Viewer port: ${vitePort}${vitePort !== VITE_PREFERRED ? ` (${VITE_PREFERRED} was busy)` : ""}`,
);
console.log(`[vibe-replay] Viewer:      http://localhost:${vitePort}  (HMR enabled)`);
console.log(`[vibe-replay] CLI watch:   auto-restarts on packages/cli/src changes`);
console.log(
  `[vibe-replay] Mode:        ${dashboardMode ? "dashboard-first (auto-open dashboard)" : "interactive menu"}`,
);
console.log();

// Start Vite dev server (backgrounded) — port + strictPort via env vars in vite.config.ts
const cloudApiUrl = process.env.VIBE_REPLAY_API_URL || "http://localhost:8787";
vite = spawnPnpm(["--filter", "@vibe-replay/viewer", "dev"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_PORT: String(vitePort),
    VITE_API_PORT: String(apiPort),
    VITE_CLOUD_API_URL: cloudApiUrl,
  },
});

// Pipe Vite output to a log file
const { createWriteStream } = await import("node:fs");
const logPath = viewerLogPath(vitePort);
const logStream = createWriteStream(logPath);
vite.stdout.pipe(logStream);
vite.stderr.pipe(logStream);
console.log(`[vibe-replay] Viewer logs: ${logPath}`);

// ── CLI with custom file watcher ──────────────────────────────────────
// We avoid `tsx watch` because it intercepts stdin (Enter = restart),
// which conflicts with interactive prompts (inquirer select menus).
// Instead, we use plain `tsx` + Node's fs.watch for restarts.

const cliEnv = {
  ...process.env,
  VIBE_REPLAY_DEV_MENU: "1",
  VIBE_REPLAY_API_URL: cloudApiUrl,
  VIBE_API_PORT: String(apiPort),
  VIBE_VIEWER_PORT: String(vitePort),
};

const cliScript = "packages/cli/src/index.ts";
const cliExtraArgs = dashboardMode ? ["-d"] : [];

let restarting = false;
let shuttingDown = false;
let hasOpenedBrowser = false;
let startingCli = false;

function startCli() {
  // Run tsx via `node --import tsx` (see spawnTsx) instead of the
  // node_modules/.bin/tsx shim — the shim is a .cmd on Windows that spawn()
  // can't exec directly, and spawning Node directly keeps Ctrl+C reliable.
  const cliEnvForRun = {
    ...cliEnv,
    // Open browser only once per dev launcher process to avoid tab spam on restarts.
    VIBE_REPLAY_NO_AUTO_OPEN: hasOpenedBrowser ? "1" : "0",
  };
  cli = spawnTsx([cliScript, ...cliExtraArgs], {
    stdio: "inherit",
    env: cliEnvForRun,
  });
  hasOpenedBrowser = true;

  cli.on("exit", (code, signal) => {
    if (restarting || startingCli || shuttingDown) return; // handled by the caller
    void shutdown(code ?? (signal === "SIGINT" ? 130 : 1));
  });
}

function killCli() {
  return killProcessTree(cli);
}

function restartCli() {
  if (restarting || shuttingDown) return;
  restarting = true;
  console.log("\n[dev] change detected — restarting CLI...\n");
  cli.on("exit", () => {
    restarting = false;
    if (shuttingDown) return;
    startCli();
  });
  killCli();
}

// Cleanup on exit
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.all([killProcessTree(cli), killProcessTree(vite)]);
    await Promise.all([waitForProcessTree(cli), waitForProcessTree(vite)]);
    await Promise.all(reservations.map(({ release }) => release()));
  } finally {
    logStream.end();
    process.exit(exitCode);
  }
}

vite.on("exit", (code) => {
  if (!shuttingDown) {
    void shutdown(code ?? 1);
  }
});

process.on("SIGINT", () => {
  void shutdown(130);
});

process.on("SIGTERM", () => {
  void shutdown(143);
});

process.on("SIGHUP", () => {
  void shutdown(129);
});

// Start Vite first so the CLI can safely open the viewer when its API binds.
try {
  await waitForPortBound(vitePort, vite, "Vite");
  startingCli = true;
  startCli();
  if (dashboardMode) await waitForPortBound(apiPort, cli, "CLI API");
  startingCli = false;
} catch (error) {
  startingCli = false;
  console.error(`[vibe-replay] Dev server startup failed: ${error.message}`);
  await shutdown(1);
}

// Watch CLI source + shared types for changes after the initial child has
// started. This avoids handling a file event before `cli` exists while Vite
// or the dashboard API is still becoming ready.
// Note: fs.watch({ recursive: true }) works on macOS/Windows natively.
// On Linux it requires Node 22+; older Node only watches the top-level dir.
let debounce;
for (const dir of ["packages/cli/src", "packages/types/src"]) {
  watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    clearTimeout(debounce);
    debounce = setTimeout(restartCli, 200);
  });
}
