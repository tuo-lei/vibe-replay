import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sqlite-reader.js", () => ({
  CURSOR_SYSTEM_CONTEXT_RE: /^<(?:user_info|system_reminder|agent_transcripts|rules|git_status)>/,
  isSystemContextText: (text: string) =>
    /^<(?:user_info|system_reminder|agent_transcripts|rules|git_status)>/.test(text.trim()),
  parseCursorSqlite: vi.fn(),
}));

import { transformToReplay } from "../../transform.js";
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

    // Use a non-.jsonl path so this test exercises the sqlite return path only.
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

  it("parses inline tool_use blocks from Cursor transcripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-parser-test-"));
    tempDirs.push(dir);
    const transcript = join(dir, "session.jsonl");

    const lines = [
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>Inspect this session</user_query>" }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Quick status update for the user." },
            {
              type: "tool_use",
              id: "tool-read-1",
              name: "ReadFile",
              input: { path: "/tmp/demo.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-1",
              content: [{ type: "text", text: "const demo = true;" }],
            },
          ],
        },
      }),
    ].join("\n");
    await writeFile(transcript, `${lines}\n`, "utf-8");

    const parsed = await parseCursorSession([transcript]);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    const toolScene = replay.scenes.find(
      (scene) => scene.type === "tool-call" && scene.toolName === "ReadFile",
    );

    expect(
      parsed.turns.some((turn) => turn.blocks.some((block) => block.type === "tool_use")),
    ).toBe(true);
    expect(toolScene).toBeDefined();
    expect(toolScene && toolScene.type === "tool-call" && toolScene.result).toContain(
      "const demo = true;",
    );
  });

  it("strips hidden planning text from assistant updates before replay generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-parser-test-"));
    tempDirs.push(dir);
    const transcript = join(dir, "session.jsonl");

    const lines = [
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>Inspect this session</user_query>" }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: [
                "先看一下最近的 Cursor 行为，然后我直接验证生成链路。",
                "",
                "**Planning next steps**",
                "",
                "I need to inspect the parser, compare the SQLite path, and decide whether to trim the text.",
                "I should also check whether inline tool_use blocks are available.",
              ].join("\n"),
            },
            {
              type: "tool_use",
              id: "tool-read-2",
              name: "ReadFile",
              input: { path: "/tmp/demo.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: [
                "**Internal only**",
                "",
                "I need to search more files before I know what to do.",
                "I think I should keep reading for now.",
              ].join("\n"),
            },
            {
              type: "tool_use",
              id: "tool-read-3",
              name: "ReadFile",
              input: { path: "/tmp/other.ts" },
            },
          ],
        },
      }),
    ].join("\n");
    await writeFile(transcript, `${lines}\n`, "utf-8");

    const parsed = await parseCursorSession([transcript]);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    const textResponses = replay.scenes
      .filter((scene) => scene.type === "text-response")
      .map((scene) => scene.content);

    expect(textResponses).toContain("先看一下最近的 Cursor 行为，然后我直接验证生成链路。");
    expect(textResponses.join("\n")).not.toContain("Planning next steps");
    expect(textResponses.join("\n")).not.toContain("I need to inspect the parser");
    expect(textResponses.join("\n")).not.toContain("Internal only");
  });

  it("keeps visible assistant prose when bold headings are not Cursor planning markers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-parser-test-"));
    tempDirs.push(dir);
    const transcript = join(dir, "session.jsonl");

    const lines = [
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>Inspect this session</user_query>" }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: [
                "**Why this fix works**",
                "",
                "I need to mention that this function has a subtle bug.",
                "I should explain why before I fix it.",
              ].join("\n"),
            },
          ],
        },
      }),
    ].join("\n");
    await writeFile(transcript, `${lines}\n`, "utf-8");

    const parsed = await parseCursorSession([transcript]);
    const replay = transformToReplay(parsed, "cursor", "~/test");
    const textResponses = replay.scenes
      .filter((scene) => scene.type === "text-response")
      .map((scene) => scene.content);

    expect(textResponses).toContain(
      "**Why this fix works**\n\nI need to mention that this function has a subtle bug.\nI should explain why before I fix it.",
    );
  });
});
