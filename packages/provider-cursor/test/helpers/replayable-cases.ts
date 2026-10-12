import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import initSqlJs from "sql.js";

export const LATE_REPLAYABLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const INLINE_REPLAYABLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ALL_EMPTY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const MISSING_BUBBLES_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * A global-state DB where discovery must decide, per composer, whether any
 * bubble is replayable. The late composer buries its only real bubble behind
 * more empty ones than a single probe chunk holds, so an early-exit probe has
 * to keep going instead of giving up after the first batch.
 */
async function replayabilityDbBytes(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);",
    );
    const put = (key: string, value: unknown) =>
      db.run("INSERT INTO cursorDiskKV VALUES (?, ?)", [key, JSON.stringify(value)]);

    const lateIds = [...Array.from({ length: 20 }, (_, i) => `empty-${i}`), "real"];
    put(`composerData:${LATE_REPLAYABLE_ID}`, {
      name: "Late replayable",
      createdAt: 1800000000000,
      fullConversationHeadersOnly: lateIds.map((bubbleId) => ({ bubbleId })),
    });
    for (const bubbleId of lateIds) {
      put(`bubbleId:${LATE_REPLAYABLE_ID}:${bubbleId}`, {
        type: bubbleId === "real" ? 1 : 2,
        text: bubbleId === "real" ? "Investigate slow discovery" : "",
      });
    }

    put(`composerData:${INLINE_REPLAYABLE_ID}`, {
      name: "Inline replayable",
      createdAt: 1800000000001,
      conversation: [{ type: 1, text: "Inline prompt" }],
    });

    const emptyIds = ["e0", "e1", "e2"];
    put(`composerData:${ALL_EMPTY_ID}`, {
      name: "All empty",
      createdAt: 1800000000002,
      fullConversationHeadersOnly: emptyIds.map((bubbleId) => ({ bubbleId })),
    });
    for (const bubbleId of emptyIds) {
      put(`bubbleId:${ALL_EMPTY_ID}:${bubbleId}`, { type: 2, text: "" });
    }

    put(`composerData:${MISSING_BUBBLES_ID}`, {
      name: "Missing bubbles",
      createdAt: 1800000000003,
      fullConversationHeadersOnly: [{ bubbleId: "gone-1" }, { bubbleId: "gone-2" }],
    });
    return db.export();
  } finally {
    db.close();
  }
}

/** Register the shared replayability assertions against one storage backend. */
export function defineReplayableDiscoveryCases(
  backend: string,
  discover: (dbPath: string) => Promise<Array<{ sessionId: string }>>,
): void {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it(`${backend}: keeps composers with any replayable bubble and drops the rest`, async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cursor-replayable-"));
    roots.push(root);
    const dbPath = join(root, "state.vscdb");
    await writeFile(dbPath, await replayabilityDbBytes());

    const ids = (await discover(dbPath)).map((session) => session.sessionId).sort();
    expect(ids).toEqual([LATE_REPLAYABLE_ID, INLINE_REPLAYABLE_ID].sort());
  });
}
