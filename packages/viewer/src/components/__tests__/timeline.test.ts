import { describe, expect, it } from "vitest";
import { clampTimelineIndex, timelineIndexFromPointer, timelineProgressPct } from "../Timeline";

describe("timeline helpers", () => {
  it("clamps current indices into the scene range for ARIA values", () => {
    expect(clampTimelineIndex(-1, 5)).toBe(0);
    expect(clampTimelineIndex(2, 5)).toBe(2);
    expect(clampTimelineIndex(5, 5)).toBe(4);
    expect(clampTimelineIndex(0, 0)).toBe(0);
  });

  it("maps pointer positions to valid scene indices", () => {
    expect(timelineIndexFromPointer(-10, 100, 5)).toBe(0);
    expect(timelineIndexFromPointer(0, 100, 5)).toBe(0);
    expect(timelineIndexFromPointer(99, 100, 5)).toBe(4);
    expect(timelineIndexFromPointer(100, 100, 5)).toBe(4);
    expect(timelineIndexFromPointer(120, 100, 5)).toBe(4);
    expect(timelineIndexFromPointer(50, 0, 5)).toBe(0);
  });

  it("keeps progress between empty and complete", () => {
    expect(timelineProgressPct(-1, 5)).toBe(0);
    expect(timelineProgressPct(1, 5)).toBe(40);
    expect(timelineProgressPct(10, 5)).toBe(100);
    expect(timelineProgressPct(0, 0)).toBe(0);
  });
});
