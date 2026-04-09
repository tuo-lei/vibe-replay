/**
 * Stable machine identification using OS-native hardware/installation IDs.
 *
 * Same approach as node-machine-id but without the dependency:
 * - macOS: IOPlatformUUID (hardware-bound, survives OS reinstall)
 * - Linux: /var/lib/dbus/machine-id or /etc/machine-id (installation-bound)
 * - Windows: MachineGuid from registry (installation-bound)
 *
 * The raw ID is SHA-256 hashed for privacy (no raw hardware IDs leave the machine).
 * Result is cached in memory after first call.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";

let cachedId: string | null = null;
let cachedName: string | null = null;

function getRawMachineId(): string {
  const os = platform();

  if (os === "darwin") {
    // macOS: IOPlatformUUID — hardware-bound, persists across reinstalls
    try {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } catch {
      // fall through
    }
  }

  if (os === "linux") {
    // Linux: /var/lib/dbus/machine-id or /etc/machine-id
    for (const path of ["/var/lib/dbus/machine-id", "/etc/machine-id"]) {
      try {
        const id = readFileSync(path, "utf-8").trim();
        if (id) return id;
      } catch {
        // try next
      }
    }
  }

  if (os === "win32") {
    // Windows: MachineGuid from registry
    try {
      const out = execSync(
        'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf-8", timeout: 5000 },
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } catch {
      // fall through
    }
  }

  // Fallback: hostname (less stable but better than nothing)
  return `fallback-${hostname()}`;
}

/** Get a stable, privacy-safe machine ID (SHA-256 hash of OS native ID). */
export function getMachineId(): string {
  if (cachedId) return cachedId;
  const raw = getRawMachineId();
  cachedId = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return cachedId;
}

/** Get a human-readable machine name. Note: sent to cloud unhashed (raw hostname). */
export function getMachineName(): string {
  if (cachedName) return cachedName;
  cachedName = hostname();
  return cachedName;
}
