import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformToReplay } from "@vibe-replay/replay-core/transform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDotSessions, parseDotExport, parseDotSession } from "../src/index.js";

// Synthetic text and IDs, shaped after the user-visible conversation read response.
const message = (id: string, author = "user", text = "Make a small replay") => ({
  message_id: id,
  channel: "chatgpt",
  author,
  content: { text, library_attachments: [] },
  sent_at: "2026-10-04T01:00:00.000000+00:00",
  deleted_at: null,
});
const page = (
  before: unknown[] = [],
  current: unknown = message("assistant-1", "aeon", "Done."),
  partial = false,
) => ({ before, message: current, after: [], partial });
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "dot-import-"));
  directories.push(path);
  return path;
}

describe("dot conversation import", () => {
  it("maps only visible messages, preserving order and original text", () => {
    const parsed = parseDotExport(page([message("human-1")]));
    expect(parsed.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(parsed.turns[0].blocks).toEqual([{ type: "text", text: "Make a small replay" }]);
    expect(parsed.turns[0].timestamp).toBe("2026-10-04T01:00:00.000Z");
    expect(parsed.dataSource).toBe("json");
    expect(parsed.tokenUsage).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.totalDurationMs).toBeUndefined();
  });
  it("deduplicates IDs and respects deletion tombstones", () => {
    const first = message("human-1");
    const parsed = parseDotExport({
      ...page([first, first]),
      after: [{ ...first, deleted_at: "2026-10-04T02:00:00Z" }],
    });
    expect(parsed.turns.map((turn) => turn.messageId)).toEqual(["assistant-1"]);
  });
  it("does not expose arbitrary metadata, internal roles, or fetch attachment content", () => {
    const current = {
      ...message("visible", "aeon", "Visible text"),
      content: {
        text: "Visible text",
        library_attachments: [{ url: "https://example.invalid/private" }],
      },
      message_metadata: { secret: "internal" },
    };
    const parsed = parseDotExport(
      page(
        [
          message("system", "system", "internal"),
          message("developer", "developer", "internal"),
          null,
        ],
        current,
        true,
      ),
    );
    expect(parsed.turns).toHaveLength(1);
    expect(JSON.stringify(parsed.turns)).not.toContain("internal");
    expect(JSON.stringify(parsed.turns)).not.toContain("example.invalid");
    expect(parsed.dataSourceInfo?.notes).toContain(
      "The source marks this conversation window as partial.",
    );
    expect(parsed.dataSourceInfo?.notes).toContain(
      "3 unsupported or malformed message records were omitted.",
    );
  });
  it("omits invalid timestamps and never guesses a model or clock time", () => {
    const parsed = parseDotExport(page([], { ...message("bad-time"), sent_at: "invalid" }));
    expect(parsed.startTime).toBeUndefined();
    expect(parsed.endTime).toBeUndefined();
    expect(parsed.turns[0].timestamp).toBeUndefined();
  });
  it("rejects unrelated JSON and raw runtime records", () => {
    for (const raw of [
      null,
      [],
      {},
      { type: "session_meta", payload: {} },
      { before: [], after: [] },
    ]) {
      expect(() => parseDotExport(raw)).toThrow("Expected a dot conversation read response");
    }
  });
  it.each([30, 500])("preserves all %i synthetic messages", (count) => {
    const parsed = parseDotExport(
      page(
        Array.from({ length: count - 1 }, (_, index) =>
          message(`msg-${index}`, index % 2 ? "aeon" : "user"),
        ),
      ),
    );
    expect(parsed.turns).toHaveLength(count);
    expect(new Set(parsed.turns.map((turn) => turn.messageId)).size).toBe(count);
  });
  it("has deterministic snapshot identity, distinct from native session IDs", () => {
    const a = parseDotExport(page([message("a")]));
    const b = parseDotExport(page([message("b")]));
    expect(a.sessionId).toMatch(/^dot-[a-f0-9]{20}$/);
    expect(parseDotExport(page([message("a")])).sessionId).toBe(a.sessionId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
  it("only discovers explicitly configured JSON export files", async () => {
    vi.stubEnv("DOT_EXPORTS_DIR", "");
    expect(await discoverDotSessions()).toEqual([]);
    const dir = await directory();
    vi.stubEnv("DOT_EXPORTS_DIR", dir);
    await writeFile(join(dir, "sample.json"), JSON.stringify(page([message("human-1")])));
    await writeFile(join(dir, "unrelated.json"), "{}");
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "ignored.jsonl"), JSON.stringify(page([message("hidden")])));
    const sessions = await discoverDotSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("dot");
    expect(sessions[0].promptCount).toBe(1);
    expect((await parseDotSession(sessions[0].filePaths, sessions[0])).turns).toHaveLength(2);
  });
  it("fails clearly for empty exports or unscoped multiple files", async () => {
    const dir = await directory();
    const path = join(dir, "empty.json");
    await writeFile(path, JSON.stringify(page([], null)));
    await expect(parseDotSession(path)).rejects.toThrow("no replayable conversation text");
    await expect(parseDotSession([path, path])).rejects.toThrow(
      "multi-file merging is not supported",
    );
  });
});

describe("dot replay rendering", () => {
  it.each([30, 500])("transforms %i messages without fabricated execution data", (count) => {
    const parsed = parseDotExport(
      page(
        Array.from({ length: count - 1 }, (_, index) =>
          message(`render-${index}`, index % 2 ? "aeon" : "user"),
        ),
      ),
    );
    const replay = transformToReplay(parsed, "dot", "dot conversations");
    expect(replay.scenes).toHaveLength(count);
    expect(replay.meta.provider).toBe("dot");
    expect(replay.meta.dataSource).toBe("json");
    expect(replay.meta.stats.toolCalls).toBe(0);
    expect(replay.meta.stats.thinkingBlocks).toBe(0);
    expect(replay.meta.tokenUsage).toBeUndefined();
    expect(replay.meta.dataSourceInfo?.notes).toContain(
      "Imported dot conversation text only; this is not a native agent session transcript.",
    );
  });
});

it("does not resurrect a deleted message when a stale duplicate follows", () => {
  const original = message("deleted");
  const parsed = parseDotExport(
    page([{ ...original, deleted_at: "2026-10-04T03:00:00Z" }, original]),
  );
  expect(parsed.turns.map((turn) => turn.messageId)).toEqual(["assistant-1"]);
});

it("distinguishes corrected, deleted, and reordered snapshots with the same IDs", () => {
  const original = parseDotExport(page([message("human")]));
  const corrected = parseDotExport(page([message("human", "user", "Corrected text")]));
  const deleted = parseDotExport(
    page([{ ...message("human"), deleted_at: "2026-10-04T03:00:00Z" }]),
  );
  const reversed = parseDotExport(
    page([message("assistant-1", "aeon", "Done.")], message("human")),
  );
  expect(
    new Set([original, corrected, deleted, reversed].map((parsed) => parsed.sessionId)).size,
  ).toBe(4);
});

it("leaves replay start time unavailable rather than fabricating the import date", () => {
  const parsed = parseDotExport(page([], { ...message("unknown-time", "aeon"), sent_at: null }));
  const replay = transformToReplay(parsed, "dot", "dot conversations");
  expect(replay.meta.startTime).toBe("");
  expect(replay.meta.endTime).toBeUndefined();
});

it("discovers assistant-only windows and edited snapshots independently", async () => {
  const dir = await directory();
  vi.stubEnv("DOT_EXPORTS_DIR", dir);
  await writeFile(join(dir, "a.json"), JSON.stringify(page()));
  await writeFile(
    join(dir, "b.json"),
    JSON.stringify(page([], message("assistant-1", "aeon", "Corrected answer."))),
  );
  const sessions = await discoverDotSessions();
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(2);
  expect(sessions.map((session) => session.transcriptStatus)).toEqual([undefined, undefined]);
});
