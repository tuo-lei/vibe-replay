import { describe, expect, it } from "vitest";
import { countComposerConversationHeaders } from "./sqlite-reader.js";

describe("countComposerConversationHeaders", () => {
  it("returns zero when headers are missing", () => {
    expect(countComposerConversationHeaders({})).toBe(0);
  });

  it("returns zero when headers are not an array", () => {
    expect(countComposerConversationHeaders({ fullConversationHeadersOnly: "oops" })).toBe(0);
  });

  it("returns array length for replayable composer payloads", () => {
    expect(
      countComposerConversationHeaders({
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }, { bubbleId: "c" }],
      }),
    ).toBe(3);
  });
});
