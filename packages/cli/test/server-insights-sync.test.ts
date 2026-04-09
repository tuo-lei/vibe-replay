import { describe, expect, it } from "vitest";
import { __testables } from "../src/server.js";

describe("buildInsightsSyncBatches", () => {
  it("splits large daily sync payloads into stable batches", () => {
    const days = Array.from({ length: 140 }, (_unused, index) => ({
      date: `date-${index}`,
      sessions: index,
    }));

    const batches = __testables.buildInsightsSyncBatches(days, [], "date-999", 90);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(90);
    expect(batches[1]).toHaveLength(50);
    expect(batches[0][0]?.date).toBe("date-0");
    expect(batches[0][89]?.date).toBe("date-89");
    expect(batches[1][0]?.date).toBe("date-90");
    expect(batches[1][49]?.date).toBe("date-139");
  });

  it("skips already-synced past days but always keeps today", () => {
    const days = [
      { date: "2026-04-07", sessions: 1 },
      { date: "2026-04-08", sessions: 2 },
      { date: "2026-04-09", sessions: 3 },
    ];

    const batches = __testables.buildInsightsSyncBatches(
      days,
      ["2026-04-07", "2026-04-08", "2026-04-09"],
      "2026-04-09",
      90,
    );

    expect(batches).toEqual([[{ date: "2026-04-09", sessions: 3 }]]);
  });

  it("returns no batches when every non-today day is already synced", () => {
    const days = [
      { date: "2026-04-07", sessions: 1 },
      { date: "2026-04-08", sessions: 2 },
    ];

    const batches = __testables.buildInsightsSyncBatches(
      days,
      ["2026-04-07", "2026-04-08"],
      "2026-04-09",
      90,
    );

    expect(batches).toEqual([]);
  });
});
