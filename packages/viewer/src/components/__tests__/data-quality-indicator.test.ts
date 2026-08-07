import { describe, expect, it } from "vitest";
import type { ReplaySession } from "../../types";
import { getSessionDataQualityNotes } from "../DataQualityIndicator";

function metaWithWarnings(
  parseWarnings: NonNullable<ReplaySession["meta"]["parseWarnings"]>,
): ReplaySession["meta"] {
  return {
    sessionId: "test-session",
    slug: "test-session",
    provider: "cursor",
    startTime: "2026-01-01T00:00:00.000Z",
    cwd: "~/project",
    project: "project",
    stats: {
      sceneCount: 1,
      userPrompts: 1,
      toolCalls: 0,
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      costEstimate: 0.001,
    },
    parseWarnings,
  };
}

describe("getSessionDataQualityNotes", () => {
  it("formats parser warnings with kind, source, and line context", () => {
    expect(
      getSessionDataQualityNotes(
        metaWithWarnings([
          {
            kind: "malformed-json",
            count: 2,
            source: "cursor transcript JSONL",
            firstLine: 3,
            message: "Skipped malformed JSONL line",
          },
          {
            kind: "missing-image",
            count: 1,
            source: "cursor transcript image reference",
            message: "Skipped image reference because the file could not be read",
          },
        ]),
      ),
    ).toEqual([
      "2 malformed JSONL lines skipped in cursor transcript JSONL first at line 3.",
      "1 image file skipped in cursor transcript image reference.",
    ]);
  });

  it("explains why token usage can exist without a cost estimate", () => {
    const meta = metaWithWarnings([]);
    meta.provider = "opencode";
    meta.model = "local-model";
    delete meta.stats.costEstimate;

    expect(getSessionDataQualityNotes(meta)).toContain(
      "Cost estimate is unavailable because model pricing or attribution is unknown.",
    );
  });

  it("explains missing cost when model attribution is absent", () => {
    const meta = metaWithWarnings([]);
    meta.provider = "opencode";
    delete meta.stats.costEstimate;

    expect(getSessionDataQualityNotes(meta)).toContain(
      "Cost estimate is unavailable because model pricing or attribution is unknown.",
    );
  });
});
