import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testables } from "../src/cursor/discover.js";

const tempDirs: string[] = [];
const IS_WINDOWS = process.platform === "win32";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-discover-"));
  tempDirs.push(root);
  return root;
}

/**
 * Mirror how Cursor encodes a workspace path into a `~/.cursor/projects`
 * directory name. On Windows the drive colon is dropped and every `\` becomes
 * `-`; on POSIX every `/` becomes `-`.
 */
function encodeCursorProjectPath(path: string): string {
  if (IS_WINDOWS) return path.replace(":", "").replaceAll("\\", "-");
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

  it.skipIf(IS_WINDOWS)("falls back to slash-decoded paths when no real path matches", async () => {
    await expect(__testables.decodeProjectDir("-definitely-missing-cursor-path")).resolves.toBe(
      "/definitely/missing/cursor/path",
    );
  });

  it.runIf(IS_WINDOWS)(
    "falls back to a backslash-decoded drive path when no real path matches",
    async () => {
      await expect(__testables.decodeProjectDir("Z-definitely-missing-cursor-path")).resolves.toBe(
        "Z:\\definitely\\missing\\cursor\\path",
      );
    },
  );
});
