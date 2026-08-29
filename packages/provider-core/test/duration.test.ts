import { describe, expect, it } from "vitest";
import {
  buildTurnDurationIntervals,
  estimateActiveDuration,
  getTimestampBounds,
  sumDurationIntervals,
  toDurationInterval,
} from "../src/duration.js";

describe("getTimestampBounds", () => {
  it("returns chronological bounds for unordered timestamps", () => {
    expect(
      getTimestampBounds(["2026-06-09T09:01:05Z", "2026-06-09T09:00:00Z", "2026-06-09T09:01:00Z"]),
    ).toEqual({
      startTime: "2026-06-09T09:00:00Z",
      endTime: "2026-06-09T09:01:05Z",
    });
  });

  it("ignores missing and invalid timestamps", () => {
    expect(getTimestampBounds([undefined, "not-a-date"])).toEqual({
      startTime: undefined,
      endTime: undefined,
    });
  });

  it("returns single timestamp as both bounds", () => {
    expect(getTimestampBounds(["2026-06-09T09:00:00Z"])).toEqual({
      startTime: "2026-06-09T09:00:00Z",
      endTime: "2026-06-09T09:00:00Z",
    });
  });

  it("returns undefined for empty input", () => {
    expect(getTimestampBounds([])).toEqual({ startTime: undefined, endTime: undefined });
  });
});

describe("toDurationInterval", () => {
  it("returns interval when ordered and finite", () => {
    expect(toDurationInterval(0, 1000)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("returns undefined when either endpoint missing", () => {
    expect(toDurationInterval(undefined, 1000)).toBeUndefined();
    expect(toDurationInterval(0, undefined)).toBeUndefined();
  });

  it("returns undefined for NaN / Infinity", () => {
    expect(toDurationInterval(Number.NaN, 1000)).toBeUndefined();
    expect(toDurationInterval(0, Number.NaN)).toBeUndefined();
    expect(toDurationInterval(Number.POSITIVE_INFINITY, 1000)).toBeUndefined();
    expect(toDurationInterval(0, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("returns undefined when end <= start", () => {
    expect(toDurationInterval(1000, 1000)).toBeUndefined();
    expect(toDurationInterval(2000, 1000)).toBeUndefined();
  });
});

describe("buildTurnDurationIntervals", () => {
  it("uses the last assistant event as the turn end", () => {
    expect(
      buildTurnDurationIntervals([
        { role: "user", startMs: 0 },
        { role: "assistant", endMs: 1_000 },
        { role: "assistant", endMs: 4_000 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 4_000 }]);
  });

  it("keeps missing or incomplete turns unavailable", () => {
    expect(
      buildTurnDurationIntervals([
        { role: "user" },
        { role: "assistant", endMs: 1_000 },
        { role: "user", startMs: 2_000 },
      ]),
    ).toEqual([undefined, undefined]);
  });

  it("builds separate intervals for multiple user prompts", () => {
    expect(
      buildTurnDurationIntervals([
        { role: "user", startMs: 0 },
        { role: "assistant", endMs: 10_000 },
        { role: "user", startMs: 5_000 },
        { role: "assistant", endMs: 15_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 10_000 },
      { startMs: 5_000, endMs: 15_000 },
    ]);
  });

  it("ignores assistant events before any user turn", () => {
    expect(
      buildTurnDurationIntervals([
        { role: "assistant", endMs: 5_000 },
        { role: "user", startMs: 10_000 },
        { role: "assistant", endMs: 12_000 },
      ]),
    ).toEqual([{ startMs: 10_000, endMs: 12_000 }]);
  });

  it("ignores NaN / Infinity timestamps", () => {
    expect(
      buildTurnDurationIntervals([
        { role: "user", startMs: Number.NaN },
        { role: "assistant", endMs: 1_000 },
        { role: "user", startMs: Number.POSITIVE_INFINITY },
        { role: "assistant", endMs: 2_000 },
      ]),
    ).toEqual([undefined, undefined]);
  });

  it("handles empty events", () => {
    expect(buildTurnDurationIntervals([])).toEqual([]);
  });

  it("treats a user turn with no assistant as undefined interval", () => {
    expect(buildTurnDurationIntervals([{ role: "user", startMs: 0 }])).toEqual([undefined]);
  });
});

describe("sumDurationIntervals", () => {
  it("merges overlapping intervals before summing", () => {
    expect(
      sumDurationIntervals([
        { startMs: 0, endMs: 10_000 },
        { startMs: 5_000, endMs: 15_000 },
        { startMs: 20_000, endMs: 25_000 },
      ]),
    ).toBe(20_000);
  });

  it("merges nested intervals", () => {
    expect(
      sumDurationIntervals([
        { startMs: 0, endMs: 20_000 },
        { startMs: 5_000, endMs: 10_000 },
      ]),
    ).toBe(20_000);
  });

  it("handles touching intervals as merged (start == currentEnd)", () => {
    expect(
      sumDurationIntervals([
        { startMs: 0, endMs: 10_000 },
        { startMs: 10_000, endMs: 20_000 },
      ]),
    ).toBe(20_000);
  });

  it("handles unsorted intervals", () => {
    expect(
      sumDurationIntervals([
        { startMs: 20_000, endMs: 30_000 },
        { startMs: 0, endMs: 10_000 },
      ]),
    ).toBe(20_000);
  });

  it("ignores invalid and missing intervals", () => {
    expect(
      sumDurationIntervals([
        undefined,
        { startMs: 1_000, endMs: 1_000 },
        { startMs: Number.NaN, endMs: 2_000 },
        { startMs: Number.POSITIVE_INFINITY, endMs: 2_000 },
      ]),
    ).toBeUndefined();
  });

  it("returns single interval duration", () => {
    expect(sumDurationIntervals([{ startMs: 0, endMs: 5_000 }])).toBe(5_000);
  });

  it("returns undefined for empty input", () => {
    expect(sumDurationIntervals([])).toBeUndefined();
    expect(sumDurationIntervals([undefined])).toBeUndefined();
  });
});

describe("estimateActiveDuration", () => {
  it("returns undefined for fewer than 2 timestamps", () => {
    expect(estimateActiveDuration([])).toBeUndefined();
    expect(estimateActiveDuration(["2026-03-25T10:00:00Z"])).toBeUndefined();
  });

  it("returns undefined for all invalid timestamps", () => {
    expect(estimateActiveDuration(["not-a-date", "also-bad"])).toBeUndefined();
  });

  it("caps idle gaps at maxGapMs", () => {
    const timestamps = [
      "2026-03-25T10:00:00Z",
      "2026-03-25T10:02:00Z",
      "2026-03-25T18:00:00Z",
      "2026-03-25T18:01:00Z",
    ];
    expect(estimateActiveDuration(timestamps)).toBe(8 * 60 * 1000);
  });

  it("respects custom maxGapMs", () => {
    const timestamps = ["2026-03-25T10:00:00Z", "2026-03-25T10:10:00Z"];
    expect(estimateActiveDuration(timestamps)).toBe(5 * 60 * 1000);
    expect(estimateActiveDuration(timestamps, 15 * 60 * 1000)).toBe(10 * 60 * 1000);
  });

  it("handles out-of-order timestamps", () => {
    const timestamps = ["2026-03-25T10:03:00Z", "2026-03-25T10:00:00Z", "2026-03-25T10:01:00Z"];
    expect(estimateActiveDuration(timestamps)).toBe(3 * 60 * 1000);
  });
});
