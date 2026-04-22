import { describe, expect, it } from "vitest";
import { localDayKey } from "../src/utils.js";

// The timezone-sensitive rollover tests only mean something when the runner's
// local zone is west of UTC (e.g. CI defaulting to UTC would flip the invariant).
// Guard them so the suite is stable regardless of where it runs.
const tzOffsetMin = new Date().getTimezoneOffset();

describe("localDayKey", () => {
  it("buckets late-evening PST activity into the local day, not the UTC next-day", () => {
    // 2026-03-04 04:28 UTC is 2026-03-03 20:28 PST. Slicing the ISO string gave 2026-03-04;
    // the helper must return the local day when running in a negative-offset zone.
    if (tzOffsetMin <= 0) return;
    expect(localDayKey("2026-03-04T04:28:17.516Z")).toBe("2026-03-03");
  });

  it("accepts a Date instance", () => {
    const d = new Date(2026, 2, 3, 20, 28); // Mar 3 2026 20:28 local
    expect(localDayKey(d)).toBe("2026-03-03");
  });

  it("accepts a unix ms number", () => {
    const d = new Date(2026, 0, 15, 9, 0);
    expect(localDayKey(d.getTime())).toBe("2026-01-15");
  });

  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(localDayKey(new Date(2026, 8, 9))).toBe("2026-09-09");
  });

  it("returns undefined for null, undefined, or empty input", () => {
    expect(localDayKey(null)).toBeUndefined();
    expect(localDayKey(undefined)).toBeUndefined();
    expect(localDayKey("")).toBeUndefined();
  });

  it("returns undefined for an unparseable string", () => {
    expect(localDayKey("not a date")).toBeUndefined();
  });
});
