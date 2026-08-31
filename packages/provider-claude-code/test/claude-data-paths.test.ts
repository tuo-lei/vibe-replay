import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeDataDirs } from "../src/claude-data-paths.js";

describe("claudeDataDirs", () => {
  it("finds standard and MSIX Windows data roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vr-claude-paths-"));
    const home = join(root, "home");
    const appData = join(root, "roaming");
    const localAppData = join(root, "local");
    const packageRoot = join(localAppData, "Packages", "Claude_pzs8sxrjxfjjc");
    const thirdPartyPackageRoot = join(localAppData, "Packages", "Claude-3p_example");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(thirdPartyPackageRoot, { recursive: true });
    await mkdir(join(localAppData, "Packages", "Unrelated_app"), { recursive: true });

    const dirs = await claudeDataDirs("win32", home, {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    });

    expect(dirs).toContain(join(appData, "Claude"));
    expect(dirs).toContain(join(appData, "Claude-3p"));
    expect(dirs).toContain(join(localAppData, "Claude"));
    expect(dirs).toContain(join(localAppData, "Claude-3p"));
    expect(dirs).toContain(join(packageRoot, "LocalCache", "Roaming", "Claude"));
    expect(dirs).toContain(join(packageRoot, "LocalCache", "Roaming", "Claude-3p"));
    expect(dirs).toContain(join(thirdPartyPackageRoot, "LocalCache", "Roaming", "Claude"));
    expect(dirs).not.toContain(join(localAppData, "Packages", "Unrelated_app"));
  });

  it("uses the user profile when Windows environment variables are absent", async () => {
    const home = join(tmpdir(), "vr-claude-home");
    const dirs = await claudeDataDirs("win32", home, {});

    expect(dirs).toContain(join(home, "AppData", "Roaming", "Claude"));
    expect(dirs).toContain(join(home, "AppData", "Local", "Claude-3p"));
  });

  it("keeps macOS support and does not invent Linux storage roots", async () => {
    const home = join(tmpdir(), "vr-claude-home");
    const macDirs = await claudeDataDirs("darwin", home, {});

    expect(macDirs).toEqual([
      join(home, "Library", "Application Support", "Claude"),
      join(home, "Library", "Application Support", "Claude-3p"),
    ]);
    await expect(claudeDataDirs("linux", home, {})).resolves.toEqual([]);
  });
});
