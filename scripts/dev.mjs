#!/usr/bin/env node
/**
 * Dev launcher — finds free ports for both Vite (viewer) and the CLI API server,
 * so multiple `pnpm dev` sessions can run simultaneously without conflicts.
 *
 * Usage:
 *   node scripts/dev.mjs            # normal dev
 *   node scripts/dev.mjs -d         # dashboard mode (passes -d to CLI)
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { findFreePort } from "./dev-utils.mjs";

const VITE_PREFERRED = 5173;
const API_PREFERRED = 13456;

const dashboardMode = process.argv.includes("-d");

// Find two non-colliding free ports
const apiPort = await findFreePort(API_PREFERRED);
const vitePort = await findFreePort(VITE_PREFERRED);

console.log();
console.log(
  `[vibe-replay] API port:    ${apiPort}${apiPort !== API_PREFERRED ? ` (${API_PREFERRED} was busy)` : ""}`,
);
console.log(
  `[vibe-replay] Viewer port: ${vitePort}${vitePort !== VITE_PREFERRED ? ` (${VITE_PREFERRED} was busy)` : ""}`,
);
console.log(`[vibe-replay] Viewer:      http://localhost:${vitePort}  (HMR enabled)`);
console.log(`[vibe-replay] CLI watch:   auto-restarts on packages/cli/src changes`);
console.log();

// Start Vite dev server (backgrounded) — port + strictPort via env vars in vite.config.ts
const vite = spawn("pnpm", ["--filter", "@vibe-replay/viewer", "dev"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VITE_PORT: String(vitePort), VITE_API_PORT: String(apiPort) },
});

// Pipe Vite output to a log file
const { createWriteStream } = await import("node:fs");
const logPath = `/tmp/vibe-replay-viewer-${vitePort}.log`;
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
  VIBE_API_PORT: String(apiPort),
  VIBE_VIEWER_PORT: String(vitePort),
};

const cliScript = "packages/cli/src/index.ts";
const cliExtraArgs = dashboardMode ? ["-d"] : [];

let cli;
let restarting = false;
let shuttingDown = false;

function startCli() {
  // Use node_modules/.bin/tsx directly instead of npx to avoid an extra
  // wrapper process that swallows signals (making Ctrl+C unreliable).
  cli = spawn("node_modules/.bin/tsx", [cliScript, ...cliExtraArgs], {
    stdio: "inherit",
    env: cliEnv,
  });

  cli.on("exit", (code, signal) => {
    if (restarting) return; // will be respawned by the watcher
    cleanup();
    process.exit(code ?? (signal === "SIGINT" ? 130 : 0));
  });
}

function killCli() {
  try { cli.kill("SIGTERM"); } catch {}
}

function restartCli() {
  if (restarting || shuttingDown) return;
  restarting = true;
  console.log("\n[dev] change detected — restarting CLI...\n");
  cli.on("exit", () => {
    restarting = false;
    startCli();
  });
  killCli();
}

startCli();

// Watch CLI source + shared types for changes
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

// Cleanup on exit
function cleanup() {
  shuttingDown = true;
  try { vite.kill("SIGTERM"); } catch {}
}

process.on("SIGINT", () => {
  cleanup();
  killCli();
  // Give children a moment to exit, then force quit
  setTimeout(() => process.exit(130), 500);
});

process.on("SIGTERM", () => {
  cleanup();
  killCli();
  setTimeout(() => process.exit(143), 500);
});
