import { describe, expect, it } from "vitest";
import { parseQuickShareInfo } from "./quick-share";

describe("parseQuickShareInfo", () => {
  it("parses active status and filters malformed viewers", () => {
    expect(
      parseQuickShareInfo({
        active: true,
        url: "https://example.test/share/box#key",
        sizeBytes: 123,
        maxBytes: 456,
        startedAt: "2026-09-21T00:00:00.000Z",
        viewers: [
          { id: "viewer-1", name: "Blue Otter" },
          { id: 2, name: "invalid" },
        ],
      }),
    ).toEqual({
      url: "https://example.test/share/box#key",
      sizeBytes: 123,
      maxBytes: 456,
      startedAt: "2026-09-21T00:00:00.000Z",
      viewers: [{ id: "viewer-1", name: "Blue Otter" }],
    });
  });

  it("returns null for inactive or malformed status", () => {
    expect(parseQuickShareInfo({ active: false })).toBeNull();
    expect(parseQuickShareInfo({ active: true })).toBeNull();
  });

  it("uses caller fallbacks for a valid response missing size metadata", () => {
    expect(
      parseQuickShareInfo(
        { active: true, url: "https://example.test/share/box#key", viewers: [] },
        { sizeBytes: 100, maxBytes: 200 },
      ),
    ).toMatchObject({ sizeBytes: 100, maxBytes: 200 });
  });
});
