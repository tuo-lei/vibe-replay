import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEV_VARS_PATH = "cloudflare/.dev.vars";
const LOCAL_AUTH_SECRET = ["vibe", "replay", "local", "e2e"].join("-");
const LOCAL_GITHUB_CLIENT_ID = ["vibe", "replay", "e2e", "client"].join("-");
const LOCAL_GITHUB_CLIENT_SECRET = ["vibe", "replay", "e2e", "github"].join("-");
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "cloudflare", "drizzle");

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

/** Initialize an isolated D1 from the checked-in Drizzle migrations. */
export async function migrateLocalD1(persistTo: string): Promise<void> {
  const migrationFile = join(persistTo, "e2e-schema.sql");
  const migrationNames = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationSql = (
    await Promise.all(migrationNames.map((name) => readFile(join(MIGRATIONS_DIR, name), "utf8")))
  )
    .join("\n")
    .replaceAll(/-->\s*statement-breakpoint/g, "");
  await writeFile(migrationFile, migrationSql, "utf8");

  execSync(
    `pnpm exec wrangler d1 execute vibe-replay-db --local --persist-to "${persistTo}" --file "${migrationFile}"`,
    { cwd: "cloudflare", stdio: "pipe" },
  );
}
