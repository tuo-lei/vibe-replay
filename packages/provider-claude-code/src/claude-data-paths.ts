import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WINDOWS_CLAUDE_PACKAGE_RE = /^Claude(?:-3p)?_/i;

/**
 * Return Claude Desktop data roots for the current installation.
 *
 * Windows has both unpackaged installs (`%APPDATA%`) and MSIX installs
 * (`%LOCALAPPDATA%\Packages\...\LocalCache\Roaming`). Third-party Claude
 * Desktop builds use `Claude-3p`, while the standard app uses `Claude`.
 */
export async function claudeDataDirs(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dirs: string[] = [];

  const add = (dir: string | undefined): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };

  if (platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");
    add(join(applicationSupport, "Claude"));
    add(join(applicationSupport, "Claude-3p"));
    return dirs;
  }

  if (platform !== "win32") return dirs;

  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");

  add(join(appData, "Claude"));
  add(join(appData, "Claude-3p"));
  add(join(localAppData, "Claude"));
  add(join(localAppData, "Claude-3p"));

  const packagesDir = join(localAppData, "Packages");
  try {
    const entries = await readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !WINDOWS_CLAUDE_PACKAGE_RE.test(entry.name)) continue;

      const roamingDir = join(packagesDir, entry.name, "LocalCache", "Roaming");
      add(join(roamingDir, "Claude"));
      add(join(roamingDir, "Claude-3p"));
    }
  } catch {
    // Missing package storage is normal for unpackaged installs.
  }

  return dirs;
}
