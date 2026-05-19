import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testables } from "./discover.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-discover-"));
  tempDirs.push(root);
  return root;
}

function encodeCursorProjectPath(path: string): string {
  return path.replaceAll("/", "-");
}

describe("cursor project directory decoding", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("decodes simple absolute paths", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, "simple", "project");
    await mkdir(workspace, { recursive: true });

    await expect(__testables.decodeProjectDir(encodeCursorProjectPath(workspace))).resolves.toBe(
      workspace,
    );
  });

  it("preserves literal hyphens in directory names", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, "my-project", "workspace-root");
    await mkdir(workspace, { recursive: true });

    await expect(__testables.decodeProjectDir(encodeCursorProjectPath(workspace))).resolves.toBe(
      workspace,
    );
  });

  it("tries slash boundaries before longer hyphenated candidates", async () => {
    const root = await makeTempRoot();
    const slashPreferred = join(root, "my", "project");
    await mkdir(slashPreferred, { recursive: true });
    await mkdir(join(root, "my-project"), { recursive: true });

    await expect(
      __testables.decodeProjectDir(encodeCursorProjectPath(slashPreferred)),
    ).resolves.toBe(slashPreferred);
  });

  it("falls back to slash-decoded paths when no real path matches", async () => {
    await expect(__testables.decodeProjectDir("-definitely-missing-cursor-path")).resolves.toBe(
      "/definitely/missing/cursor/path",
    );
  });
});
