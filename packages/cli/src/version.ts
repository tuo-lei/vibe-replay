import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let version = "0.0.0";
try {
  const pkg = require("../package.json");
  if (pkg && typeof pkg.version === "string" && pkg.version.trim()) {
    version = pkg.version;
  }
} catch {
  // Keep fallback when package.json is unavailable.
}

export const CLI_VERSION = version;
