import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ writes: [] as Array<[string, unknown]> }));
vi.mock("@vibe-replay/provider-core/cache", () => ({
  readFileCache: async () => null,
  writeFileCache: async (key: string, data: unknown) => {
    cache.writes.push([key, data]);
  },
}));

import { withReadOnlySqlite } from "@vibe-replay/provider-core/utils";
import { __testables, type TranscriptScanCache } from "../src/cursor/discover.js";

const entry = (size: number) => ({
  size,
  mtimeMs: 1,
  scan: {
    valid: true,
    lineCount: 2,
    firstPrompt: "p",
    promptCount: 1,
    toolCallCount: 0,
    editCountEst: 0,
    delegatedPrompts: [],
  },
});
const cacheWith = (
  previous: string[],
  fresh: string[],
  scannedAny: boolean,
): TranscriptScanCache => ({
  previous: Object.fromEntries(previous.map((path) => [path, entry(1)])),
  fresh: new Map(fresh.map((path) => [path, entry(1)])),
  scannedAny,
});

describe("persistTranscriptScanCache", () => {
  beforeEach(() => {
    cache.writes.length = 0;
  });

  it("writes only the entries seen by this run, which prunes deleted transcripts", async () => {
    await __testables.persistTranscriptScanCache(cacheWith(["/a", "/gone"], ["/a", "/b"], true));
    expect(cache.writes).toEqual([
      ["cursor-transcript-scan-v1", { "/a": entry(1), "/b": entry(1) }],
    ]);
  });

  it("prunes even when nothing was rescanned", async () => {
    await __testables.persistTranscriptScanCache(cacheWith(["/a", "/gone"], ["/a"], false));
    expect(cache.writes).toHaveLength(1);
  });

  it("skips the write on a warm run that changed nothing", async () => {
    await __testables.persistTranscriptScanCache(cacheWith(["/a", "/b"], ["/a", "/b"], false));
    expect(cache.writes).toHaveLength(0);
  });

  it("never writes inside a read-only scope", async () => {
    await withReadOnlySqlite(true, () =>
      __testables.persistTranscriptScanCache(cacheWith([], ["/a"], true)),
    );
    expect(cache.writes).toHaveLength(0);
  });
});
