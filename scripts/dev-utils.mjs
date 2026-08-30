/**
 * Shared utilities for dev launcher scripts.
 */
import { spawn } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
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
  return spawn("pnpm", args, {
    ...options,
    shell: IS_WINDOWS,
    // Put the child tree in its own group so shutdown can terminate pnpm and
    // the actual dev server together.
    detached: !IS_WINDOWS,
  });
}

/**
 * Spawn `tsx` to run a TypeScript entry cross-platform. Uses the current Node
 * binary with tsx registered as a loader (`node --import tsx`) instead of the
 * `node_modules/.bin/tsx` shim, which is a `.cmd` on Windows and cannot be
 * exec'd directly. Spawning Node directly also keeps Ctrl+C / signal handling
 * reliable (no wrapper process).
 */
export function spawnTsx(scriptArgs, options = {}) {
  return spawn(process.execPath, ["--import", "tsx", ...scriptArgs], {
    ...options,
    detached: !IS_WINDOWS,
  });
}

/**
 * Signal a launcher child and all of its descendants. Dev commands often
 * spawn through pnpm, so killing only the direct child can leave Vite/Astro
 * listening after the launcher exits.
 */
export function killProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    try {
      child.kill(signal);
    } catch {}
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/** Wait for a detached child process group to exit, then force-kill it. */
export async function waitForProcessTree(child, timeoutMs = 1_000) {
  if (!child?.pid || IS_WINDOWS) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  killProcessTree(child, "SIGKILL");
}

/** Cross-platform temp log path for the backgrounded Vite viewer. */
export function viewerLogPath(port) {
  return join(tmpdir(), `vibe-replay-viewer-${port}.log`);
}

function portLockPath(port) {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\vibe-replay-port-${port}`
    : join(tmpdir(), `vibe-replay-port-${port}.sock`);
}

/** Validate a user-supplied TCP port. Port 0 is intentionally not accepted. */
export function parsePort(value, label = "Port") {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${label} must be an integer between 1024 and 65535`);
  }
  return port;
}

/**
 * Read one logical port from one or more compatible environment variables.
 * Supplying aliases with different values is almost certainly a configuration
 * mistake, so fail before starting either child process.
 */
export function readPortOverride(names, label) {
  const configured = names
    .map((name) => ({ name, value: process.env[name] }))
    .filter(({ value }) => value !== undefined && value !== "")
    .map(({ name, value }) => ({ name, port: parsePort(value, label) }));
  const ports = new Set(configured.map(({ port }) => port));
  if (ports.size > 1) {
    throw new Error(
      `${label} has conflicting values: ${configured.map(({ name, port }) => `${name}=${port}`).join(", ")}`,
    );
  }
  return configured[0]?.port;
}

/**
 * Check if a port is free on BOTH IPv4 and IPv6 (macOS Vite listens on ::1).
 * Returns true if the port is available.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const s4 = createServer();
    s4.unref();
    s4.on("error", () => s4.close(() => resolve(false)));
    s4.listen(port, "127.0.0.1", () => {
      s4.close(() => {
        const s6 = createServer();
        s6.unref();
        s6.on("error", () => s6.close(() => resolve(false)));
        s6.listen(port, "::1", () => {
          s6.close(() => resolve(true));
        });
      });
    });
  });
}

function closeLockServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function isLockAlive(lockPath) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(lockPath);
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function removeStaleLock(lockPath) {
  if (IS_WINDOWS) {
    // Named pipes are removed by the OS when their server dies. Retrying is
    // enough to observe that release; unlink is not reliable for pipe paths.
    return true;
  }
  try {
    if (!(await lstat(lockPath)).isSocket()) return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

/**
 * Reserve a live IPC endpoint rather than a marker file. A crashed launcher
 * leaves only a disconnected Unix socket, which the next launcher can safely
 * reclaim without racing a live owner based on PID checks.
 */
async function tryAcquirePortLock(port) {
  const lockPath = portLockPath(port);

  while (true) {
    const lockServer = createServer((socket) => socket.end());
    const acquired = await new Promise((resolve, reject) => {
      const onError = (error) => {
        lockServer.removeListener("error", onError);
        if (error?.code === "EADDRINUSE") resolve(false);
        else reject(error);
      };
      lockServer.once("error", onError);
      lockServer.listen(lockPath, () => {
        lockServer.removeListener("error", onError);
        resolve(true);
      });
    });

    if (acquired) {
      lockServer.unref();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await closeLockServer(lockServer);
      };
    }

    await closeLockServer(lockServer);
    if (await isLockAlive(lockPath)) return null;
    if (!(await removeStaleLock(lockPath))) return null;
  }
}

/** Reserve a specific free port until the returned release function is called. */
export async function reservePort(port, label = "Port") {
  const parsedPort = parsePort(port, label);
  const releaseLock = await tryAcquirePortLock(parsedPort);
  if (!releaseLock) {
    throw new Error(`${label} ${parsedPort} is already reserved by another dev process`);
  }
  if (!(await isPortFree(parsedPort))) {
    await releaseLock();
    throw new Error(`${label} ${parsedPort} is already in use`);
  }
  return { port: parsedPort, release: releaseLock };
}

/** Find and reserve a free port starting from `preferred`, incrementing on conflict. */
export async function reserveFreePort(preferred, range = 100) {
  const firstPort = parsePort(preferred, "Preferred port");
  if (!Number.isInteger(range) || range < 1) {
    throw new Error("Port search range must be a positive integer");
  }
  const lastPort = Math.min(65535, firstPort + range - 1);
  for (let port = firstPort; port <= lastPort; port++) {
    const releaseLock = await tryAcquirePortLock(port);
    if (!releaseLock) continue;
    if (await isPortFree(port)) return { port, release: releaseLock };
    await releaseLock();
  }
  throw new Error(`No free port found in range ${firstPort}-${lastPort}`);
}

/**
 * Legacy non-reserving probe. New launchers should use reserveFreePort so a
 * second launcher cannot select the same port during child startup.
 */
export async function findFreePort(preferred) {
  const reservation = await reserveFreePort(preferred);
  await reservation.release();
  return reservation.port;
}

/** Wait until a child process has actually bound the reserved port. */
export async function waitForPortBound(port, child, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(`${label} exited before binding port ${port}`);
    }
    if (!(await isPortFree(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not bind port ${port} within ${timeoutMs}ms`);
}
