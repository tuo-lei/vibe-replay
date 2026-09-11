import { describe, expect, it } from "vitest";
import { localDayOffset } from "../InsightsPage";

describe("Insights calendar helpers", () => {
  it("moves by local calendar days without mutating the source", () => {
    const source = new Date(2025, 10, 1, 12, 0, 0);

    const next = localDayOffset(source, 1);
    const previous = localDayOffset(source, -1);

    expect(next.getFullYear()).toBe(2025);
    expect(next.getMonth()).toBe(10);
    expect(next.getDate()).toBe(2);
    expect(previous.getDate()).toBe(31);
    expect(source.getDate()).toBe(1);
  });
});
