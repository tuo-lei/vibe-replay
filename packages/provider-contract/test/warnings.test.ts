import type { ParseWarning } from "@vibe-replay/types";
import { describe, expect, it } from "vitest";
import { addParseWarning, compactWarningSample } from "../src/warnings.js";

describe("addParseWarning", () => {
  it("appends a new warning with default count of 1", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, {
      kind: "missing-image",
      message: "image not found",
      source: "a.jsonl",
    });

    expect(warnings).toEqual([
      {
        kind: "missing-image",
        count: 1,
        message: "image not found",
        source: "a.jsonl",
        firstLine: undefined,
        sample: undefined,
      },
    ]);
  });

  it("honors an explicit count on a new warning", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m", count: 5 });

    expect(warnings[0]?.count).toBe(5);
  });

  it("coalesces duplicates (same kind + source + message) by summing counts", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "a.jsonl" });
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "a.jsonl" });
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "a.jsonl", count: 3 });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.count).toBe(5);
  });

  it("does not coalesce when source differs", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "a.jsonl" });
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "b.jsonl" });

    expect(warnings).toHaveLength(2);
  });

  it("does not coalesce when kind differs", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m", source: "a.jsonl" });
    addParseWarning(warnings, { kind: "malformed-json", message: "m", source: "a.jsonl" });

    expect(warnings).toHaveLength(2);
  });

  it("does not coalesce when message differs", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "first", source: "a.jsonl" });
    addParseWarning(warnings, { kind: "missing-image", message: "second", source: "a.jsonl" });

    expect(warnings).toHaveLength(2);
  });

  it("coalesces warnings that share an undefined source", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m" });
    addParseWarning(warnings, { kind: "missing-image", message: "m" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.count).toBe(2);
  });

  it("preserves the first entry's sample and firstLine when a duplicate coalesces", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, {
      kind: "missing-image",
      message: "m",
      source: "a.jsonl",
      sample: "first.png",
      firstLine: 7,
    });
    // A later duplicate only bumps count; it must not overwrite sample/firstLine.
    addParseWarning(warnings, {
      kind: "missing-image",
      message: "m",
      source: "a.jsonl",
      sample: "second.png",
      firstLine: 99,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.count).toBe(2);
    expect(warnings[0]?.sample).toBe("first.png");
    expect(warnings[0]?.firstLine).toBe(7);
  });

  it("drops the sample for malformed-json warnings (avoids leaking raw source)", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, {
      kind: "malformed-json",
      message: "bad json",
      source: "a.jsonl",
      sample: "{ secret: token }",
    });

    expect(warnings[0]?.sample).toBeUndefined();
  });

  it("preserves the sample for non-malformed-json warnings", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, {
      kind: "missing-image",
      message: "m",
      source: "a.jsonl",
      sample: "img-123.png",
    });

    expect(warnings[0]?.sample).toBe("img-123.png");
  });

  it("preserves firstLine when provided", () => {
    const warnings: ParseWarning[] = [];
    addParseWarning(warnings, { kind: "missing-image", message: "m", firstLine: 42 });

    expect(warnings[0]?.firstLine).toBe(42);
  });
});

describe("compactWarningSample", () => {
  it("collapses runs of whitespace into single spaces", () => {
    expect(compactWarningSample("a\n\tb   c")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(compactWarningSample("  hello  ")).toBe("hello");
  });

  it("returns the value unchanged when within the limit", () => {
    expect(compactWarningSample("short")).toBe("short");
  });

  it("truncates and appends an ellipsis when over the default limit", () => {
    const defaultMax = 160;
    const long = "x".repeat(200);
    const result = compactWarningSample(long);

    expect(result).toHaveLength(defaultMax + "...".length);
    expect(result.endsWith("...")).toBe(true);
  });

  it("respects a custom max length", () => {
    expect(compactWarningSample("abcdef", 3)).toBe("abc...");
  });

  it("does not truncate when exactly at the limit", () => {
    expect(compactWarningSample("abc", 3)).toBe("abc");
  });

  it("counts length after whitespace compaction, not before", () => {
    // 6 visible chars after collapse; well under the default limit despite long whitespace runs
    expect(compactWarningSample("a       b       c")).toBe("a b c");
  });
});
