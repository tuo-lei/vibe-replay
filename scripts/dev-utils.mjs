/**
 * Shared utilities for dev launcher scripts.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Spawn `pnpm` cross-platform. On Windows the pnpm binary is a `.cmd`/`.ps1`
 * shim that `spawn()` cannot exec directly (it throws `ENOENT`), so route
 * through the shell there. Args are simple identifiers, so shell quoting is
 * not a concern.
 */
export function spawnPnpm(args, options = {}) {
  return spawn("pnpm", args, { ...options, shell: IS_WINDOWS });
}

/**
 * Spawn `tsx` to run a TypeScript entry cross-platform. Uses the current Node
 * binary with tsx registered as a loader (`node --import tsx`) instead of the
 * `node_modules/.bin/tsx` shim, which is a `.cmd` on Windows and cannot be
 * exec'd directly. Spawning Node directly also keeps Ctrl+C / signal handling
 * reliable (no wrapper process).
 */
export function spawnTsx(scriptArgs, options = {}) {
  return spawn(process.execPath, ["--import", "tsx", ...scriptArgs], options);
}

/** Cross-platform temp log path for the backgrounded Vite viewer. */
export function viewerLogPath(port) {
  return join(tmpdir(), `vibe-replay-viewer-${port}.log`);
}

/**
 * Check if a port is free on BOTH IPv4 and IPv6 (macOS Vite listens on ::1).
 * Returns true if the port is available.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const s4 = createServer();
    s4.unref();
    s4.on("error", () => resolve(false));
    s4.listen(port, "127.0.0.1", () => {
      s4.close(() => {
        const s6 = createServer();
        s6.unref();
        s6.on("error", () => resolve(false));
        s6.listen(port, "::1", () => {
          s6.close(() => resolve(true));
        });
      });
    });
  });
}

/** Find a free port starting from `preferred`, incrementing on conflict. */
export async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${preferred}-${preferred + 99}`);
}
