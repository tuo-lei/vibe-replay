import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeGitUrl, readGitRepo } from "../src/utils.js";

describe("normalizeGitUrl", () => {
  it.each([
    ["https://github.com/org/repo.git", "org/repo"],
    ["https://github.com/org/repo", "org/repo"],
    ["https://github.com/org/sub/repo.git", "org/sub"],
    ["git@github.com:org/repo.git", "org/repo"],
    ["ssh://git@github.com/org/repo", "org/repo"],
    ["https://github.com/org/repo.git   ", "org/repo"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeGitUrl(input)).toBe(expected);
  });

  it.each(["", "not a url", "https://github.com/org", "git@github.com:org"])(
    "returns undefined for invalid input %s",
    (input) => {
      expect(normalizeGitUrl(input)).toBeUndefined();
    },
  );
});

describe("readGitRepo", () => {
  it("reads origin from a normal .git/config", async () => {
    const project = await mkdtemp(join(tmpdir(), "vibe-replay-git-"));
    await mkdir(join(project, ".git"));
    await writeFile(
      join(project, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:org/repo.git\n',
    );

    await expect(readGitRepo(project)).resolves.toBe("org/repo");
  });

  it("reads origin from the common git dir for worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-replay-worktree-"));
    const project = join(root, "worktree");
    const gitdir = join(root, ".git", "worktrees", "feature");
    const commonDir = join(root, ".git");
    await mkdir(project, { recursive: true });
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(project, ".git"), `gitdir: ${gitdir}\n`);
    await writeFile(join(gitdir, "commondir"), "../..\n");
    await writeFile(
      join(commonDir, "config"),
      '[remote "origin"]\n\turl = https://github.com/org/worktree-repo.git\n',
    );

    await expect(readGitRepo(project)).resolves.toBe("org/worktree-repo");
  });
});
