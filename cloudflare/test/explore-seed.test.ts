import { describe, expect, it } from "vitest";
import { FEATURED_EXPLORE_GIST_IDS, FEATURED_EXPLORE_GISTS } from "../src/explore-seed";
import { ensureFeaturedExploreReplays, pinFeaturedExploreReplays } from "../src/explore-seed";

describe("featured Explore seed", () => {
  it("pins known public demos in seed order ahead of community rows", () => {
    const community = {
      gist_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Community replay",
    };
    const shuffled = [
      { gist_id: FEATURED_EXPLORE_GIST_IDS[2], title: "zh" },
      community,
      { gist_id: FEATURED_EXPLORE_GIST_IDS[0], title: "home" },
      { gist_id: FEATURED_EXPLORE_GIST_IDS[1], title: "en" },
    ];

    expect(pinFeaturedExploreReplays(shuffled).map((row) => row.gist_id)).toEqual([
      FEATURED_EXPLORE_GIST_IDS[0],
      FEATURED_EXPLORE_GIST_IDS[1],
      FEATURED_EXPLORE_GIST_IDS[2],
      community.gist_id,
    ]);
  });

  it("keeps cloud rows without gist ids in the unpinned tail", () => {
    const cloud = { gist_id: null, title: "R2 public", cloud_id: "abc" };
    expect(pinFeaturedExploreReplays([cloud])[0]).toEqual(cloud);
  });

  it("inserts missing featured gists once and leaves existing view counts", async () => {
    const rows = new Map<string, { gist_id: string; title: string; view_count: number }>();
    const db = {
      prepare(query: string) {
        return {
          bind(...values: (string | number | null)[]) {
            return {
              async first<T>() {
                if (query.includes("SELECT")) {
                  const gistId = String(values[0]);
                  return (rows.get(gistId) as T | undefined) ?? null;
                }
                return null;
              },
              async run() {
                if (!query.includes("INSERT")) return;
                const gistId = String(values[0]);
                if (rows.has(gistId)) return;
                rows.set(gistId, {
                  gist_id: gistId,
                  title: String(values[1]),
                  view_count: 1,
                });
              },
            };
          },
        };
      },
    };

    expect(await ensureFeaturedExploreReplays(db)).toBe(FEATURED_EXPLORE_GISTS.length);
    expect(rows.size).toBe(FEATURED_EXPLORE_GISTS.length);

    const featuredId = FEATURED_EXPLORE_GIST_IDS[0];
    rows.set(featuredId, { gist_id: featuredId, title: "already indexed", view_count: 42 });
    expect(await ensureFeaturedExploreReplays(db)).toBe(0);
    expect(rows.get(featuredId)?.view_count).toBe(42);
    expect(rows.get(featuredId)?.title).toBe("already indexed");
  });
});
