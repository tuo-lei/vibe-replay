import { describe, expect, it } from "vitest";
import { normalizeGitUrl } from "../src/utils.js";

describe("normalizeGitUrl", () => {
  it("normalizes SCP-style SSH remotes", () => {
    expect(normalizeGitUrl("git@github.com:org/repo.git")).toBe("org/repo");
    expect(normalizeGitUrl("git@github.com:org/repo")).toBe("org/repo");
  });

  it("normalizes HTTPS remotes", () => {
    expect(normalizeGitUrl("https://github.com/org/repo.git")).toBe("org/repo");
    expect(normalizeGitUrl("https://github.com/org/repo")).toBe("org/repo");
  });

  it("normalizes ssh:// remotes", () => {
    expect(normalizeGitUrl("ssh://git@github.com/org/repo.git")).toBe("org/repo");
    expect(normalizeGitUrl("ssh://git@github.com/org/repo")).toBe("org/repo");
  });

  it("ignores trailing whitespace", () => {
    expect(normalizeGitUrl("git@github.com:org/repo.git   ")).toBe("org/repo");
    expect(normalizeGitUrl("https://github.com/org/repo.git   ")).toBe("org/repo");
  });

  it("returns undefined for malformed URLs", () => {
    expect(normalizeGitUrl("not-a-git-remote")).toBeUndefined();
    expect(normalizeGitUrl("https://github.com/org")).toBeUndefined();
    expect(normalizeGitUrl("git@github.com:org")).toBeUndefined();
  });
});
