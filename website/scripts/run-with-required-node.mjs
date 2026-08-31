#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_VERSION = "22.12.0";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEBSITE_DIR = dirname(SCRIPT_DIR);
const ASTRO_CLI = join(WEBSITE_DIR, "node_modules", "astro", "bin", "astro.mjs");

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function nodeVersion(binary) {
  try {
    return execFileSync(binary, ["-p", "process.versions.node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function candidateNodeBinaries() {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  add(process.execPath);
  if (process.env.NVM_BIN) add(join(process.env.NVM_BIN, executable));

  if (process.platform === "win32") {
    if (process.env.NVM_SYMLINK) add(join(process.env.NVM_SYMLINK, executable));
    if (process.env.NVM_HOME && existsSync(process.env.NVM_HOME)) {
      for (const entry of readdirSync(process.env.NVM_HOME, { withFileTypes: true })) {
        if (entry.isDirectory() && /^v?\d/.test(entry.name)) {
          add(join(process.env.NVM_HOME, entry.name, executable));
        }
      }
    }
  } else {
    const nvmDir = process.env.NVM_DIR || join(homedir(), ".nvm");
    const versionsDir = join(nvmDir, "versions", "node");
    if (existsSync(versionsDir)) {
      for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(versionsDir, entry.name, "bin", executable));
      }
    }
  }

  return candidates;
}

function resolveNodeBinary() {
  let best = null;
  for (const candidate of candidateNodeBinaries()) {
    const version = nodeVersion(candidate);
    if (!version || compareVersions(version, MIN_NODE_VERSION) < 0) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { candidate, version };
    }
  }
  if (best) return best.candidate;

  throw new Error(
    `Website scripts require Node.js >= ${MIN_NODE_VERSION} (Astro 6). ` +
      "Run: cd website && nvm install 22.12.0 && nvm use 22.12.0",
  );
}

if (!existsSync(ASTRO_CLI)) {
  throw new Error(`Astro CLI not found at ${ASTRO_CLI}. Run pnpm install first.`);
}

const result = spawnSync(resolveNodeBinary(), [ASTRO_CLI, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
