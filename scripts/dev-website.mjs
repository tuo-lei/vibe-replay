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
import {
  killProcessTree,
  readPortOverride,
  reserveFreePort,
  reservePort,
  spawnPnpm,
  waitForProcessTree,
  waitForPortBound,
  viewerLogPath,
} from "./dev-utils.mjs";

const VITE_PREFERRED = 5173;
const ASTRO_PREFERRED = 4321;

const vitePortOverride = readPortOverride(["VIBE_VIEWER_PORT", "VITE_PORT"], "Viewer port");
const astroPortOverride = readPortOverride(["VIBE_WEBSITE_PORT", "ASTRO_PORT"], "Website port");
if (vitePortOverride !== undefined && vitePortOverride === astroPortOverride) {
  throw new Error(`Viewer port and website port must be different (both are ${vitePortOverride})`);
}

const reservations = [];
let viteReservation;
let astroReservation;
try {
  viteReservation =
    vitePortOverride !== undefined
      ? await reservePort(vitePortOverride, "Viewer port")
      : await reserveFreePort(VITE_PREFERRED);
  reservations.push(viteReservation);
  astroReservation =
    astroPortOverride !== undefined
      ? await reservePort(astroPortOverride, "Website port")
      : await reserveFreePort(ASTRO_PREFERRED);
  reservations.push(astroReservation);
} catch (error) {
  await Promise.all(reservations.map(({ release }) => release()));
  throw error;
}

const vitePort = viteReservation.port;
const astroPort = astroReservation.port;

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
let vite;
let astro;
let shuttingDown = false;
let logStream;

vite = spawnPnpm(["--filter", "@vibe-replay/viewer", "dev"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, VITE_PORT: String(vitePort) },
});

const { createWriteStream } = await import("node:fs");
const logPath = viewerLogPath(vitePort);
logStream = createWriteStream(logPath);
vite.stdout.pipe(logStream);
vite.stderr.pipe(logStream);
console.log(`[vibe-replay] Viewer logs:  ${logPath}`);

// If Vite crashes, tear down Astro too
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.all([killProcessTree(astro), killProcessTree(vite)]);
    await Promise.all([waitForProcessTree(astro), waitForProcessTree(vite)]);
    await Promise.all(reservations.map(({ release }) => release()));
  } finally {
    logStream.end();
    process.exit(exitCode);
  }
}

vite.on("exit", (code) => {
  if (!shuttingDown) {
    if (code !== 0 && code !== null) {
      console.error(`[vibe-replay] Viewer process exited with code ${code}. Check ${logPath}`);
    }
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

try {
  await waitForPortBound(vitePort, vite, "Vite");

  // Start Astro after Vite is ready so /view/ never points at an unbound URL.
  astro = spawnPnpm(["--filter", "@vibe-replay/website", "dev", "--port", String(astroPort)], {
    stdio: "inherit",
    env: {
      ...process.env,
      DEV_VIEWER_URL: `http://localhost:${vitePort}`,
      DEV_STRICT_PORT: "1",
    },
  });
  astro.on("exit", (code) => {
    if (!shuttingDown) void shutdown(code ?? 1);
  });
  await waitForPortBound(astroPort, astro, "Astro");
} catch (error) {
  console.error(`[vibe-replay] Website startup failed: ${error.message}`);
  await shutdown(1);
}
