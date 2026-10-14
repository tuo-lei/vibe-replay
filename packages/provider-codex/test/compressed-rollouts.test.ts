import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCodexSessions, extractCodexSessionInfo } from "../src/codex/discover.js";
import { parseCodexSession } from "../src/codex/parser.js";
import { readCodexRolloutLines, readCodexRolloutPrefix } from "../src/codex/rollout.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function corpus(turns = 15) {
  const root = await mkdtemp(join(tmpdir(), "codex-compressed-test-"));
  roots.push(root);
  await mkdir(join(root, "sessions"));
  const path = join(root, "sessions", "rollout-2026-10-13-compressed-session.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "compressed-session", cwd: "/example/project" } },
    ...Array.from({ length: turns }, (_, i) => [
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: `检查第 ${i + 1} 项 🧪` },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: `Result ${i + 1}` },
      },
    ]).flat(),
  ];
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(`${path}.zst`, zstdCompressSync(Buffer.from(text)));
  return { root, path, text };
}

describe("Codex compressed rollouts", () => {
  it.each([15, 250])(
    "parses %i turns identically through logical and physical paths",
    async (turns) => {
      const { path, text } = await corpus(turns);
      const before = await readFile(`${path}.zst`);
      const compressed = await parseCodexSession(path);
      const explicit = await parseCodexSession(`${path}.zst`);
      await writeFile(path, text);
      const plain = await parseCodexSession(path);
      expect(compressed.turns).toHaveLength(turns * 2);
      expect(compressed.turns).toEqual(plain.turns);
      expect(explicit).toEqual(compressed);
      expect(await readFile(`${path}.zst`)).toEqual(before);
    },
  );

  it("discovers compressed-only sessions and resolves state-indexed logical paths", async () => {
    const { root, path } = await corpus();
    vi.stubEnv("CODEX_SQLITE_HOME", root);
    const { default: initSql } = await import("sql.js");
    const SQL = await initSql();
    const db = new SQL.Database();
    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, archived INTEGER)");
    db.run("INSERT INTO threads VALUES (?, ?, ?, 0)", ["compressed-session", path, "State title"]);
    await writeFile(join(root, "state_5.sqlite"), Buffer.from(db.export()));
    db.close();
    const discovered = await discoverCodexSessions(root, true, false);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      title: "State title",
      promptCount: 15,
      transcriptStatus: undefined,
      filePath: `${path}.zst`,
      filePaths: [`${path}.zst`],
      fileSize: (await stat(`${path}.zst`)).size,
    });
    expect((await parseCodexSession(discovered[0]!.filePaths)).turns).toHaveLength(30);
    expect(await readdir(join(root, "sessions"))).toEqual([`${path.split(/[/\\]/).at(-1)}.zst`]);
    expect((await discoverCodexSessions(root, false, false))[0]?.promptCount).toBe(15);
  });

  it("prefers the current plain rollout over a stale compressed sibling without duplicates", async () => {
    const { root, path, text } = await corpus();
    await writeFile(path, text.replace("Result 1", "Updated result 1"));
    const discovered = await discoverCodexSessions(root, false, false);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.filePath).toBe(path);
    expect((await parseCodexSession(`${path}.zst`)).turns).toEqual(
      (await parseCodexSession(path)).turns,
    );
    await unlink(`${path}.zst`);
    expect((await parseCodexSession(`${path}.zst`)).turns).toHaveLength(30);
  });

  it("streams concatenated frames with split UTF-8 and reads only a bounded decoded prefix", async () => {
    const { path, text } = await corpus();
    const bytes = Buffer.from(text);
    const split = bytes.indexOf(Buffer.from("检查")) + 1;
    await writeFile(
      `${path}.zst`,
      Buffer.concat([
        zstdCompressSync(bytes.subarray(0, split)),
        zstdCompressSync(bytes.subarray(split)),
      ]),
    );
    const lines: string[] = [];
    for await (const line of readCodexRolloutLines(path)) lines.push(line);
    expect(lines).toEqual(text.trimEnd().split("\n"));
    expect(await readCodexRolloutPrefix(path, 23)).toBe(bytes.subarray(0, 23).toString("utf-8"));
  });

  it.each(["invalid", "truncated"])(
    "rejects %s compression without producing a partial replay",
    async (kind) => {
      const { path } = await corpus();
      const bytes = await readFile(`${path}.zst`);
      await writeFile(
        `${path}.zst`,
        kind === "invalid" ? Buffer.from("invalid zstd") : bytes.subarray(0, -5),
      );
      await expect(parseCodexSession(path)).rejects.toThrow();
      const info = await extractCodexSessionInfo(`${path}.zst`, bytes.length);
      expect(info).toMatchObject({ transcriptStatus: "unreadable", firstPrompt: "" });
    },
  );
});
