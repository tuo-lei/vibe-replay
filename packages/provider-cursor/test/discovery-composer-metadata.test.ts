import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testSqlite } from "./helpers/global-state-db.js";

const home = join(tmpdir(), `vibe-cursor-composer-metadata-${Date.now()}`);
vi.mock("node:os", async () => ({ ...(await vi.importActual("node:os")), homedir: () => home }));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async () => null,
  writeFileCache: async () => {},
}));
const { discoverCursorSessions } = await import("../src/cursor/discover.js");
const { parseCursorSession } = await import("../src/cursor/parser.js");

const REPLAYABLE_ID = "33333333-3333-4333-8333-333333333333";
const TRANSCRIPT_ID = "44444444-4444-4444-8444-444444444444";

beforeAll(async () => {
  const SQL = await testSqlite();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);",
  );
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    `composerData:${REPLAYABLE_ID}`,
    JSON.stringify({
      name: "Global-state chat",
      modelConfig: { modelName: "claude-opus-5-5" },
      createdAt: 1800000000000,
      fullConversationHeadersOnly: [{ bubbleId: "user" }],
    }),
  ]);
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    `bubbleId:${REPLAYABLE_ID}:user`,
    JSON.stringify({ type: 1, text: "Summarize the branch" }),
  ]);
  // Headers without stored bubbles: not replayable from global state, but the
  // chat name and model still describe the transcript with the same ID.
  db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [
    `composerData:${TRANSCRIPT_ID}`,
    JSON.stringify({
      name: "Current progress summary",
      modelConfig: { modelName: "gpt-5.6-sol" },
      createdAt: 1800000000000,
      fullConversationHeadersOnly: [{ bubbleId: "missing" }],
    }),
  ]);
  const globalStorage = join(home, "Library", "Application Support", "Cursor", "User");
  await mkdir(join(globalStorage, "globalStorage"), { recursive: true });
  await writeFile(join(globalStorage, "globalStorage", "state.vscdb"), db.export());
  db.close();

  const transcriptDir = join(
    home,
    ".cursor",
    "projects",
    "tmp-project",
    "agent-transcripts",
    TRANSCRIPT_ID,
  );
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    join(transcriptDir, `${TRANSCRIPT_ID}.jsonl`),
    [
      {
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nHow is the work going?\n</user_query>" }],
        },
      },
      { role: "assistant", message: { content: [{ type: "text", text: "Here is a summary." }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

it("reports the composer model and name for global-state and transcript sessions", async () => {
  const sessions = await discoverCursorSessions({ readOnly: true });
  expect(sessions.find((session) => session.sessionId === REPLAYABLE_ID)).toMatchObject({
    title: "Global-state chat",
    model: "claude-opus-5-5",
  });
  const transcript = sessions.find((session) => session.sessionId === TRANSCRIPT_ID);
  expect(transcript).toMatchObject({
    title: "Current progress summary",
    model: "gpt-5.6-sol",
    firstPrompt: "How is the work going?",
  });

  const parsed = await parseCursorSession(transcript!.filePaths, transcript);
  expect(parsed.title).toBe("Current progress summary");
  expect(parsed.model).toBe("gpt-5.6-sol");
});
