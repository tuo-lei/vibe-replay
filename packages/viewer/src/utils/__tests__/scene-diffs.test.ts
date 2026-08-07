import { describe, expect, it } from "vitest";
import type { Scene } from "../../types";
import { getToolDiffs } from "../sceneDiffs";

function toolScene(
  overrides: Partial<Extract<Scene, { type: "tool-call" }>>,
): Extract<Scene, { type: "tool-call" }> {
  return { type: "tool-call", toolName: "Edit", input: {}, result: "", ...overrides };
}

describe("getToolDiffs", () => {
  it("falls back to the legacy primary diff", () => {
    const diff = { filePath: "a.ts", oldContent: "a", newContent: "b" };
    expect(getToolDiffs(toolScene({ diff }))).toEqual([diff]);
  });

  it("prefers the complete multi-file diff list", () => {
    const primary = { filePath: "a.ts", oldContent: "a", newContent: "b" };
    const diffs = [primary, { filePath: "b.ts", oldContent: "", newContent: "new" }];
    expect(getToolDiffs(toolScene({ diff: primary, diffs }))).toEqual(diffs);
  });
});
