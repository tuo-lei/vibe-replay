import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  jsonByteLength,
  normalizeGitUrl,
  readGitRepo,
  shortenPath,
  utf8ByteLength,
} from "../src/utils.js";

describe("privacy-safe payload sizes", () => {
  it("counts UTF-8 text and JSON bytes without returning content", () => {
    expect(utf8ByteLength("A✓")).toBe(4);
    expect(jsonByteLength({ value: "✓" })).toBe(Buffer.byteLength(JSON.stringify({ value: "✓" })));
    expect(jsonByteLength(undefined)).toBe(0);
  });
});

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

describe("shortenPath", () => {
  it("redacts Windows home paths across separators and casing", () => {
    const home = "C:\\Users\\TuoLei";

    expect(shortenPath("C:/Users/TuoLei/project", home, "win32")).toBe("~/project");
    expect(shortenPath("c:\\users\\tuolei\\project", home, "win32")).toBe("~\\project");
  });

  it("does not redact a Windows sibling path with the same prefix", () => {
    const home = "C:\\Users\\TuoLei";

    expect(shortenPath("C:/Users/TuoLei2/project", home, "win32")).toBe("C:/Users/TuoLei2/project");
  });

  it("preserves POSIX case sensitivity and separators", () => {
    const home = "/home/TuoLei";

    expect(shortenPath("/home/TuoLei/project", home, "linux")).toBe("~/project");
    expect(shortenPath("/home/tuolei/project", home, "linux")).toBe("/home/tuolei/project");
  });
});
