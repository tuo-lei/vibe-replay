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

// Start CLI with tsx watch so it auto-restarts on source changes
const cliArgs = ["tsx", "watch", "--clear-screen=false", "packages/cli/src/index.ts"];
if (dashboardMode) cliArgs.push("-d");

const cli = spawn("npx", cliArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    VIBE_REPLAY_DEV_MENU: "1",
    VIBE_API_PORT: String(apiPort),
    VIBE_VIEWER_PORT: String(vitePort),
  },
});

// Cleanup on exit
function cleanup() {
  vite.kill("SIGTERM");
}

cli.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  cli.kill("SIGINT");
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cli.kill("SIGTERM");
  cleanup();
  process.exit(143);
});
