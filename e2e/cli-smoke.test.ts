import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
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

  it("share --help documents the no-auth local HTML fallback", async () => {
    const { stdout } = await exec("node", [CLI_PATH, "share", "--help"]);
    const help = stripVTControlCharacters(stdout);
    expect(help).toMatch(/local\s+HTML/i);
    expect(help).toMatch(/without login/i);
  });

  it("share without auth opens the local HTML path instead of requiring login", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibe-share-noauth-home-"));
    const replayDir = join(home, "replay");
    const htmlPath = join(replayDir, "index.html");
    try {
      await mkdir(replayDir, { recursive: true });
      await writeFile(
        join(replayDir, "replay.json"),
        JSON.stringify({
          meta: { title: "Unauth share", slug: "unauth", sessionId: "s1", provider: "claude-code" },
          scenes: [],
        }),
      );
      await writeFile(htmlPath, "<html>local replay</html>");

      const { stdout, stderr } = await exec("node", [CLI_PATH, "share", replayDir], {
        env: {
          ...process.env,
          HOME: home,
          VIBE_REPLAY_NO_AUTO_OPEN: "1",
        },
      });
      const output = stripVTControlCharacters(`${stdout}\n${stderr}`);
      expect(output).toContain("Cloud share skipped (not logged in).");
      expect(output).toContain(htmlPath);
      expect(output).toContain(pathToFileURL(htmlPath).href);
      expect(output).toContain("vibe-replay auth login");
      expect(output).not.toMatch(/✗ Not logged in/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
