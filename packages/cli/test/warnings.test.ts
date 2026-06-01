import { describe, expect, it } from "vitest";
import { addParseWarning, compactWarningSample } from "../src/providers/warnings.js";
import type { ParseWarning } from "../src/types.js";

describe("parse warning helpers", () => {
  it("aggregates warnings by kind, source, and message", () => {
    const warnings: ParseWarning[] = [];

    addParseWarning(warnings, {
      kind: "malformed-json",
      source: "cursor transcript JSONL",
      firstLine: 3,
      message: "Skipped malformed JSONL line",
      sample: "{not-json",
    });
    addParseWarning(warnings, {
      kind: "malformed-json",
      source: "cursor transcript JSONL",
      firstLine: 8,
      message: "Skipped malformed JSONL line",
      sample: "{still-not-json",
    });

    expect(warnings).toEqual([
      {
        kind: "malformed-json",
        source: "cursor transcript JSONL",
        firstLine: 3,
        count: 2,
        message: "Skipped malformed JSONL line",
        sample: undefined,
      },
    ]);
  });

  it("keeps non-malformed warning samples for later redaction", () => {
    const warnings: ParseWarning[] = [];

    addParseWarning(warnings, {
      kind: "missing-image",
      source: "cursor transcript image reference",
      message: "Skipped image reference because the file could not be read",
      sample: "/Users/alice/project/image.png",
    });

    expect(warnings[0]?.sample).toBe("/Users/alice/project/image.png");
  });

  it("compacts long samples after callers redact them", () => {
    expect(compactWarningSample(`  ${"x".repeat(170)}  `)).toBe(`${"x".repeat(160)}...`);
  });
});
