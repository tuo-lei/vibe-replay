import { describe, expect, it } from "vitest";
import { getTimestampBounds } from "../src/duration.js";

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
});
