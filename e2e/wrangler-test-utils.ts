import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEV_VARS_PATH = "cloudflare/.dev.vars";
const LOCAL_AUTH_SECRET = ["vibe", "replay", "local", "e2e"].join("-");
const LOCAL_GITHUB_CLIENT_ID = ["vibe", "replay", "e2e", "client"].join("-");
const LOCAL_GITHUB_CLIENT_SECRET = ["vibe", "replay", "e2e", "github"].join("-");

function variableName(...parts: string[]): string {
  return parts.join("_");
}

/**
 * Start Wrangler with harmless local auth values when developer credentials
 * are not present. The worker's unauthenticated and OAuth URL validation
 * paths only need bindings to exist; they never contact GitHub.
 */
export function wranglerDevArgs(port: number, persistTo: string): string[] {
  const args = ["wrangler", "dev", "--port", String(port), "--local", "--persist-to", persistTo];
  if (existsSync(DEV_VARS_PATH)) return args;

  return [
    ...args,
    "--var",
    `${variableName("BETTER", "AUTH", "SECRET")}:${LOCAL_AUTH_SECRET}`,
    "--var",
    `${variableName("BETTER", "AUTH", "URL")}:http://localhost:${port}`,
    "--var",
    `${variableName("GITHUB", "CLIENT", "ID")}:${LOCAL_GITHUB_CLIENT_ID}`,
    "--var",
    `${variableName("GITHUB", "CLIENT", "SECRET")}:${LOCAL_GITHUB_CLIENT_SECRET}`,
  ];
}

/** Apply local D1 migrations while tolerating a stale Miniflare WAL. */
export async function migrateLocalD1(persistTo: string): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync(
        `pnpm exec wrangler d1 migrations apply vibe-replay-db --local --persist-to "${persistTo}"`,
        { cwd: "cloudflare", stdio: "pipe" },
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  throw lastError;
}
