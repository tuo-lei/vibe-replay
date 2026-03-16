import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const CLI_PATH = join(import.meta.dirname, "..", "packages/cli/dist/index.js");

describe("CLI Smoke Tests", () => {
  it("--version prints correct version", async () => {
    const { stdout } = await exec("node", [CLI_PATH, "--version"]);
    const version = stdout.trim();

    // Read expected version from package.json
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "packages/cli/package.json"), "utf-8"),
    );
    expect(version).toBe(pkg.version);
  });

  it("--help prints usage info", async () => {
    const { stdout } = await exec("node", [CLI_PATH, "--help"]);
    expect(stdout).toContain("vibe-replay");
  });
});
