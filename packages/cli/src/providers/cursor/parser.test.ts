import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sqlite-reader.js", () => ({
  parseCursorSqlite: vi.fn(),
}));

import { parseCursorSession } from "./parser.js";
import { parseCursorSqlite } from "./sqlite-reader.js";

const mockedParseCursorSqlite = vi.mocked(parseCursorSqlite);

describe("parseCursorSession", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mockedParseCursorSqlite.mockReset();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns sqlite result when available", async () => {
    mockedParseCursorSqlite.mockResolvedValueOnce({
      sessionId: "sqlite-session",
      slug: "sqlite-s",
      cwd: "/repo",
      turns: [{ role: "user", blocks: [{ type: "text", text: "hello" }] }],
      dataSource: "sqlite",
      dataSourceInfo: {
        primary: "sqlite",
        sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
      },
    });

    const parsed = await parseCursorSession(["/tmp/fake.txt"], {
      provider: "cursor",
      sessionId: "sqlite-session",
      slug: "sqlite-s",
      project: "/repo",
      cwd: "/repo",
      version: "",
      timestamp: new Date().toISOString(),
      lineCount: 0,
      fileSize: 0,
      filePath: "/tmp/fake.txt",
      filePaths: ["/tmp/fake.txt"],
      firstPrompt: "hello",
    });

    expect(parsed.dataSource).toBe("sqlite");
    expect(parsed.sessionId).toBe("sqlite-session");
  });

  it("falls back to JSONL when sqlite parsing throws", async () => {
    mockedParseCursorSqlite.mockRejectedValueOnce(new Error("no such table: meta"));

    const dir = await mkdtemp(join(tmpdir(), "cursor-parser-test-"));
    tempDirs.push(dir);
    const transcript = join(dir, "session.jsonl");

    const lines = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>build tests</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Working on it." }] },
      }),
    ].join("\n");
    await writeFile(transcript, `${lines}\n`, "utf-8");

    const parsed = await parseCursorSession([transcript], {
      provider: "cursor",
      sessionId: "session",
      slug: "session",
      project: dir,
      cwd: dir,
      version: "",
      timestamp: new Date().toISOString(),
      lineCount: 2,
      fileSize: lines.length,
      filePath: transcript,
      filePaths: [transcript],
      firstPrompt: "build tests",
    });

    expect(parsed.dataSource).toBe("jsonl");
    expect(parsed.turns.length).toBeGreaterThan(0);
    expect(parsed.turns[0]?.role).toBe("user");
    expect(parsed.dataSourceInfo?.notes?.[0]).toContain("SQLite parse failed");
    expect(parsed.dataSourceInfo?.notes?.[0]).toContain("fell back to JSONL transcript");
  });

  it("surfaces sqlite error details when no transcript fallback exists", async () => {
    mockedParseCursorSqlite.mockRejectedValueOnce(new Error("sql.js init failed"));

    await expect(
      parseCursorSession(["/tmp/fake.txt"], {
        provider: "cursor",
        sessionId: "session",
        slug: "session",
        project: "/tmp",
        cwd: "/tmp",
        version: "",
        timestamp: new Date().toISOString(),
        lineCount: 0,
        fileSize: 0,
        filePath: "/tmp/fake.txt",
        filePaths: ["/tmp/fake.txt"],
        firstPrompt: "x",
      }),
    ).rejects.toThrow(/sql\.js init failed/);
  });
});
