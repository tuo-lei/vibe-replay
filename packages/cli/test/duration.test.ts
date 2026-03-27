import { describe, expect, it } from "vitest";
import { estimateActiveDuration } from "../src/duration.js";

describe("estimateActiveDuration", () => {
  it("returns undefined for empty array", () => {
    expect(estimateActiveDuration([])).toBeUndefined();
  });

  it("returns undefined for single timestamp", () => {
    expect(estimateActiveDuration(["2026-03-25T10:00:00Z"])).toBeUndefined();
  });

  it("sums gaps within the 5-minute threshold", () => {
    const timestamps = [
      "2026-03-25T10:00:00Z",
      "2026-03-25T10:01:00Z", // +1m
      "2026-03-25T10:03:00Z", // +2m
      "2026-03-25T10:04:30Z", // +1.5m
    ];
    // Total: 4.5 minutes = 270_000 ms
    expect(estimateActiveDuration(timestamps)).toBe(270_000);
  });

  it("caps gaps at maxGapMs (idle time excluded)", () => {
    const timestamps = [
      "2026-03-25T10:00:00Z",
      "2026-03-25T10:02:00Z", // +2m (active)
      "2026-03-25T18:00:00Z", // +8h (idle — capped at 5m)
      "2026-03-25T18:01:00Z", // +1m (active)
    ];
    // 2m + 5m (capped) + 1m = 8m = 480_000 ms
    expect(estimateActiveDuration(timestamps)).toBe(480_000);
  });

  it("handles out-of-order timestamps", () => {
    const timestamps = ["2026-03-25T10:03:00Z", "2026-03-25T10:00:00Z", "2026-03-25T10:01:00Z"];
    // Sorted: 10:00, 10:01, 10:03 → 1m + 2m = 3m = 180_000 ms
    expect(estimateActiveDuration(timestamps)).toBe(180_000);
  });

  it("respects custom maxGapMs", () => {
    const timestamps = [
      "2026-03-25T10:00:00Z",
      "2026-03-25T10:10:00Z", // +10m
    ];
    // Default max gap (5m): capped → 300_000
    expect(estimateActiveDuration(timestamps)).toBe(300_000);
    // Custom max gap (15m): not capped → 600_000
    expect(estimateActiveDuration(timestamps, 15 * 60 * 1000)).toBe(600_000);
  });

  it("skips invalid timestamps", () => {
    const timestamps = ["2026-03-25T10:00:00Z", "invalid", "2026-03-25T10:02:00Z"];
    expect(estimateActiveDuration(timestamps)).toBe(120_000);
  });

  it("returns a realistic estimate for a multi-day session", () => {
    // Simulates a session spanning 3 days but with only ~30 min of actual work
    const timestamps = [
      "2026-03-24T14:00:00Z", // Day 1
      "2026-03-24T14:05:00Z",
      "2026-03-24T14:08:00Z",
      "2026-03-24T14:10:00Z",
      // 16h gap (overnight)
      "2026-03-25T06:00:00Z", // Day 2
      "2026-03-25T06:03:00Z",
      "2026-03-25T06:07:00Z",
      // 12h gap
      "2026-03-25T18:00:00Z", // Day 2 evening
      "2026-03-25T18:02:00Z",
      "2026-03-25T18:04:00Z",
    ];
    const result = estimateActiveDuration(timestamps)!;
    // Active time: (5+3+2) + 5(cap) + (3+4) + 5(cap) + (2+2) = 31 min
    expect(result).toBe(31 * 60 * 1000);
    // NOT 52 hours of wall clock time
    expect(result).toBeLessThan(60 * 60 * 1000); // under 1 hour
  });
});
