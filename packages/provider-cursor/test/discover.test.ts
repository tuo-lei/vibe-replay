import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

  it("resolves directories whose leading dot Cursor drops when encoding", async () => {
    const root = await makeTempRoot();
    const workspace = join(root, ".cursor-sdk-control", "artifacts");
    await mkdir(workspace, { recursive: true });

    const encoded = encodeCursorProjectPath(workspace).replace(
      "-.cursor-sdk-control-",
      "-cursor-sdk-control-",
    );
    await expect(__testables.decodeProjectDir(encoded)).resolves.toBe(workspace);
  });

  it("keeps a deleted leaf directory in one piece once its parent resolves", async () => {
    const root = await makeTempRoot();
    const parent = join(root, "artifacts");
    await mkdir(parent, { recursive: true });

    const deleted = join(parent, "slack-inbox-5433add3-d507-4e0a-8f71-1bd30c541913");
    await expect(__testables.decodeProjectDir(encodeCursorProjectPath(deleted))).resolves.toBe(
      deleted,
    );
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

describe("duplicate Cursor transcript discovery", () => {
  it("merges paths for the same session ID without summing prompt counts", () => {
    const base = {
      provider: "cursor",
      sessionId: "same-session",
      slug: "same-ses",
      version: "",
      timestamp: "2026-08-20T10:00:00.000Z",
      firstPrompt: "Inspect compatibility",
      promptCount: 2,
      toolCallCount: 3,
    };
    const merged = __testables.mergeDuplicateTranscriptSessions([
      {
        ...base,
        project: "/repo-a",
        cwd: "/repo-a",
        lineCount: 100,
        fileSize: 1_000,
        filePath: "/cursor/a/same-session.jsonl",
        filePaths: ["/cursor/a/same-session.jsonl"],
        toolPaths: ["/cursor/a/tool-1.txt"],
      },
      {
        ...base,
        project: "/repo-b",
        cwd: "/repo-b",
        timestamp: "2026-08-20T11:00:00.000Z",
        lineCount: 80,
        fileSize: 800,
        filePath: "/cursor/b/same-session.jsonl",
        filePaths: ["/cursor/b/same-session.jsonl"],
        toolPaths: ["/cursor/b/tool-2.txt"],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sessionId: "same-session",
      lineCount: 100,
      promptCount: 2,
      toolCallCount: 3,
      fileSize: 1_000,
      project: "/repo-a",
    });
    expect(merged[0].filePaths).toEqual([
      "/cursor/a/same-session.jsonl",
      "/cursor/b/same-session.jsonl",
    ]);
    expect(merged[0].toolPaths).toEqual(["/cursor/a/tool-1.txt", "/cursor/b/tool-2.txt"]);
  });
});

describe("Cursor transcript metadata discovery", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("finds a prompt after metadata records", async () => {
    const root = await makeTempRoot();
    const transcript = join(root, "session.jsonl");
    const metadata = Array.from({ length: 11 }, (_, index) =>
      JSON.stringify({ role: "assistant", id: `metadata-${index}` }),
    );
    const prompt = JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "Inspect the delayed prompt" }] },
    });
    await writeFile(transcript, `${metadata.join("\n")}\n${prompt}\n`, "utf8");
    const fileStat = await stat(transcript);

    const session = await __testables.extractSessionInfo(
      transcript,
      fileStat.size,
      Date.now(),
      root,
      [],
    );

    expect(session?.firstPrompt).toBe("Inspect the delayed prompt");
  });

  it("counts user prompts regardless of JSON whitespace", async () => {
    const root = await makeTempRoot();
    const transcript = join(root, "session.jsonl");
    const prompt =
      '{ "role" : "user", "message": { "content": [{ "type": "text", "text": "Count this prompt" }] } }';
    await writeFile(transcript, `${JSON.stringify({ role: "assistant" })}\n${prompt}\n`, "utf8");
    const fileStat = await stat(transcript);

    const session = await __testables.extractSessionInfo(
      transcript,
      fileStat.size,
      Date.now(),
      root,
      [],
    );

    expect(session).toMatchObject({
      firstPrompt: "Count this prompt",
      promptCount: 1,
    });
  });
});
