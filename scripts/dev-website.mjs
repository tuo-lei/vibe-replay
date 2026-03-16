#!/usr/bin/env node
/**
 * Website dev launcher — starts Vite viewer + Astro website with HMR wired up.
 *
 * - Vite viewer: serves the viewer app with HMR
 * - Astro website: serves the marketing site; /view/ redirects to Vite viewer
 *
 * Usage:
 *   node scripts/dev-website.mjs
 */
import { spawn } from "node:child_process";
import { findFreePort } from "./dev-utils.mjs";

const VITE_PREFERRED = 5173;
const ASTRO_PREFERRED = 4321;

const vitePort = await findFreePort(VITE_PREFERRED);
const astroPort = await findFreePort(ASTRO_PREFERRED);

console.log();
console.log(
  `[vibe-replay] Viewer port:  ${vitePort}${vitePort !== VITE_PREFERRED ? ` (${VITE_PREFERRED} was busy)` : ""}`,
);
console.log(
  `[vibe-replay] Website port: ${astroPort}${astroPort !== ASTRO_PREFERRED ? ` (${ASTRO_PREFERRED} was busy)` : ""}`,
);
console.log(`[vibe-replay] Website:      http://localhost:${astroPort}  (Astro HMR)`);
console.log(`[vibe-replay] Viewer:       http://localhost:${vitePort}  (Vite HMR)`);
console.log(`[vibe-replay] /view/  →     redirects to Vite viewer`);
console.log();

// Start Vite viewer dev (backgrounded, logs to file)
const vite = spawn("pnpm", ["--filter", "@vibe-replay/viewer", "dev"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VITE_PORT: String(vitePort) },
});

const { createWriteStream } = await import("node:fs");
const logPath = `/tmp/vibe-replay-viewer-${vitePort}.log`;
const logStream = createWriteStream(logPath);
vite.stdout.pipe(logStream);
vite.stderr.pipe(logStream);
console.log(`[vibe-replay] Viewer logs:  ${logPath}`);

// If Vite crashes, tear down Astro too
vite.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[vibe-replay] Viewer process exited with code ${code}. Check ${logPath}`);
  }
  astro.kill("SIGTERM");
  process.exit(code ?? 0);
});

// Start Astro website dev (foreground, inherits stdio)
const astro = spawn("pnpm", ["--filter", "@vibe-replay/website", "dev", "--port", String(astroPort)], {
  stdio: "inherit",
  env: {
    ...process.env,
    DEV_VIEWER_URL: `http://localhost:${vitePort}`,
  },
});

function cleanup() {
  vite.kill("SIGTERM");
}

astro.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  astro.kill("SIGINT");
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  astro.kill("SIGTERM");
  cleanup();
  process.exit(143);
});
