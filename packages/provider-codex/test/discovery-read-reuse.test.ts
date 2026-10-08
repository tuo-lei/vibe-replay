import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  target: "",
  count: 0,
  beforeIndex: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (path: string, options: Parameters<typeof actual.createReadStream>[1]) => {
      if (path === reads.target) reads.count++;
      if (path.endsWith("session_index.jsonl")) reads.beforeIndex?.();
      return actual.createReadStream(path, options);
    },
  };
});
import { writeFileSync } from "node:fs";
import { discoverCodexSessions } from "../src/codex/discover.js";

const prompt = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: text },
  });

async function withCorpus(action: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-discovery-reuse-"));
  const path = join(root, "sessions", "rollout.jsonl");
  const priorSqliteHome = process.env.CODEX_SQLITE_HOME;
  try {
    delete process.env.CODEX_SQLITE_HOME;
    await mkdir(join(root, "sessions"));
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "reuse", cwd: "/example/project" } }),
        prompt("Original test prompt"),
      ].join("\n"),
    );
    await writeFile(
      join(root, "session_index.jsonl"),
      JSON.stringify({ id: "reuse", thread_name: "Latest title" }),
    );
    const { default: initSql } = await import("sql.js");
    const sql = await initSql();
    const db = new sql.Database();
    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, archived INTEGER)");
    db.run("INSERT INTO threads VALUES (?, ?, ?, 0)", ["reuse", path, "State title"]);
    await writeFile(join(root, "state_5.sqlite"), Buffer.from(db.export()));
    db.close();
    reads.target = path;
    reads.count = 0;
    await action(root, path);
  } finally {
    reads.target = "";
    reads.beforeIndex = undefined;
    if (priorSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = priorSqliteHome;
    await rm(root, { recursive: true, force: true });
  }
}

describe("Codex operation-scoped discovery reads", () => {
  it("reads an unchanged state-indexed rollout once, retaining title and counts", async () => {
    await withCorpus(async (root, path) => {
      const first = await discoverCodexSessions(root, true, false);
      expect(reads.count).toBe(1);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        sessionId: "reuse",
        title: "Latest title",
        firstPrompt: "Original test prompt",
        promptCount: 1,
        lineCount: 2,
        filePaths: [path],
      });
      await appendFile(path, `\n${prompt("A later prompt")}`);
      const next = await discoverCodexSessions(root, true, false);
      expect(reads.count).toBe(2);
      expect(next[0]).toMatchObject({ promptCount: 2, lineCount: 3 });
    });
  });

  it("re-reads a same-size source rewrite between state lookup and directory traversal", async () => {
    await withCorpus(async (root, path) => {
      const replacement = [
        JSON.stringify({ type: "session_meta", payload: { id: "reuse", cwd: "/example/project" } }),
        prompt("Modified test prompt"),
      ].join("\n");
      reads.beforeIndex = () => writeFileSync(path, replacement);
      await discoverCodexSessions(root, true, false);
      expect(reads.count).toBe(2);
      reads.beforeIndex = undefined;
      expect((await discoverCodexSessions(root, true, false))[0].firstPrompt).toBe(
        "Modified test prompt",
      );
    });
  });

  it("retries unreadable content instead of memoizing it", async () => {
    await withCorpus(async (root, path) => {
      await writeFile(path, "{incomplete");
      reads.beforeIndex = () =>
        writeFileSync(
          path,
          [
            JSON.stringify({ type: "session_meta", payload: { id: "reuse" } }),
            prompt("Recovered test prompt"),
          ].join("\n"),
        );
      const result = await discoverCodexSessions(root, true, false);
      expect(reads.count).toBe(2);
      expect(result[0]).toMatchObject({
        transcriptStatus: undefined,
        firstPrompt: "Recovered test prompt",
        title: "Latest title",
      });
    });
  });
});
