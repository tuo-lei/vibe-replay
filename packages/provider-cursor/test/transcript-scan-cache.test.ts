import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testables, type TranscriptScanCache } from "../src/cursor/discover.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const user = (text: string) =>
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const assistant = JSON.stringify({
  role: "assistant",
  message: {
    content: [
      { type: "tool_use", name: "ReadFile", input: { path: "/repo/a.ts" } },
      { type: "tool_use", name: "Task", input: { prompt: "Investigate   the flaky test" } },
    ],
  },
});

async function transcript(lines: string[]): Promise<{ path: string; size: number }> {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-cursor-scan-cache-"));
  tempDirs.push(root);
  const path = join(root, "session.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return { path, size: (await stat(path)).size };
}

const emptyCache = (): TranscriptScanCache => ({
  previous: {},
  fresh: new Map(),
  scannedAny: false,
});
const reopen = (cache: TranscriptScanCache): TranscriptScanCache => ({
  previous: Object.fromEntries(cache.fresh),
  fresh: new Map(),
  scannedAny: false,
});

describe("cursor transcript scan cache", () => {
  it("reuses an unchanged transcript without reading it again", async () => {
    const file = await transcript([user("Fix the parser"), assistant]);
    const first = emptyCache();
    const info = await __testables.extractSessionInfo(
      file.path,
      file.size,
      1000,
      "/repo",
      [],
      first,
    );
    expect(info).toMatchObject({ firstPrompt: "Fix the parser", promptCount: 1, toolCallCount: 2 });
    expect(first.scannedAny).toBe(true);

    // The file is gone, so only the cache can answer.
    await rm(file.path);
    const second = reopen(first);
    const cached = await __testables.extractSessionInfo(
      file.path,
      file.size,
      1000,
      "/repo",
      [],
      second,
    );
    expect(cached).toEqual(info);
    expect(second.scannedAny).toBe(false);
    expect(second.fresh.size).toBe(1);
  });

  it("rescans when the size or mtime changes", async () => {
    const file = await transcript([user("First prompt"), assistant]);
    const first = emptyCache();
    await __testables.extractSessionInfo(file.path, file.size, 1000, "/repo", [], first);

    await writeFile(
      file.path,
      `${[user("First prompt"), assistant, user("Second prompt")].join("\n")}\n`,
    );
    await utimes(file.path, new Date(5000), new Date(5000));
    const grown = await stat(file.path);
    const second = reopen(first);
    const info = await __testables.extractSessionInfo(
      file.path,
      grown.size,
      grown.mtimeMs,
      "/repo",
      [],
      second,
    );
    expect(info?.promptCount).toBe(2);
    expect(second.scannedAny).toBe(true);

    const sameSizeNewMtime = reopen(second);
    await __testables.extractSessionInfo(
      file.path,
      grown.size,
      grown.mtimeMs + 1,
      "/repo",
      [],
      sameSizeNewMtime,
    );
    expect(sameSizeNewMtime.scannedAny).toBe(true);
  });

  it("applies the current tool artifacts and mtime to a cached scan", async () => {
    const file = await transcript([user("Fix the parser"), assistant]);
    const first = emptyCache();
    await __testables.extractSessionInfo(file.path, file.size, 1000, "/repo", [], first);
    const second = reopen(first);
    const info = await __testables.extractSessionInfo(
      file.path,
      file.size,
      1000,
      "/repo",
      ["a", "b", "c", "d"],
      second,
    );
    expect(second.scannedAny).toBe(false);
    expect(info?.toolCallCount).toBe(4);
    expect(info?.toolPaths).toEqual(["a", "b", "c", "d"]);
  });

  it("caches transcripts that are not replayable so they are not reread", async () => {
    const file = await transcript([JSON.stringify({ role: "assistant", id: "only" })]);
    const first = emptyCache();
    expect(
      await __testables.extractSessionInfo(file.path, file.size, 1, "/repo", [], first),
    ).toBeNull();
    await rm(file.path);
    const second = reopen(first);
    expect(
      await __testables.extractSessionInfo(file.path, file.size, 1, "/repo", [], second),
    ).toBeNull();
    expect(second.fresh.size).toBe(1);
    expect(second.scannedAny).toBe(false);
  });
});

describe("delegated prompt extraction", () => {
  it("only parses lines that can name a delegation tool", () => {
    const content = [
      user("hello"),
      assistant,
      JSON.stringify({
        type: "progress",
        message: { content: [{ type: "tool_use", name: "Task", input: { prompt: "streamed" } }] },
      }),
      JSON.stringify({
        message: {
          content: [{ type: "tool_use", name: "SUBAGENT", arguments: { task: "Second job" } }],
        },
      }),
      'not json but mentions "name":"task"',
    ].join("\n");
    expect(__testables.extractDelegatedPrompts(content)).toEqual([
      "Investigate the flaky test",
      "Second job",
    ]);
  });
});
