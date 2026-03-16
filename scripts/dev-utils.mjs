/**
 * Shared utilities for dev launcher scripts.
 */
import { createServer } from "node:net";

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
