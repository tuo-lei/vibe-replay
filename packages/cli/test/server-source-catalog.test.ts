import { describe, expect, it } from "vitest";
import { buildSourceSessionCatalogCache } from "../src/server-source-catalog.js";
import type { NormalizedSourceSessionCatalogCache } from "../src/server-types.js";

const source = (provider: string, sessionId: string) => ({
  provider,
  sessionId,
  slug: sessionId,
  project: "project",
  filePaths: [`/${sessionId}.jsonl`],
  timestamp: "2026-08-20T00:00:00.000Z",
});

describe("buildSourceSessionCatalogCache", () => {
  it("preserves cached records and discovery state for failed providers", () => {
    const previous: NormalizedSourceSessionCatalogCache = {
      sessions: [source("pi", "pi-old"), source("cursor", "cursor-old")],
      cachedAt: "old",
      discoveredAt: "old",
      updatedAt: "old",
      providerStates: {
        pi: { provider: "pi", discoveredAt: "old", sessionCount: 1 },
      },
      legacy: false,
    };

    const catalog = buildSourceSessionCatalogCache(
      [source("cursor", "cursor-new")],
      "new",
      previous,
      ["pi"],
    );

    expect(catalog.sessions.map((session) => `${session.provider}:${session.sessionId}`)).toEqual([
      "cursor:cursor-new",
      "pi:pi-old",
    ]);
    expect(catalog.providerStates?.pi).toEqual(previous.providerStates?.pi);
  });
});
