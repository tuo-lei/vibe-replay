import { describe, expect, it } from "vitest";
import { copyButtonLabel, quickShareReplay, replayJsonSize } from "../ExportView";

describe("export copy feedback", () => {
  it("distinguishes copied, failed, and ready states", () => {
    expect(copyButtonLabel(false, false, "Copy MD")).toBe("Copy MD");
    expect(copyButtonLabel(true, false, "Copy MD")).toBe("Copied!");
    expect(copyButtonLabel(false, true, "Copy MD")).toBe("Copy failed");
  });
});

describe("quick share snapshot", () => {
  it("uses the current annotations instead of the last persisted replay value", () => {
    const session = {
      schemaVersion: 1,
      meta: { slug: "session-1" },
      scenes: [],
      annotations: [{ id: "old" }],
    } as any;
    const annotations = [{ id: "new" }] as any;
    expect(quickShareReplay(session, annotations).annotations).toEqual(annotations);
  });

  it("keeps the base replay size separate from the annotated Quick Share snapshot", () => {
    const session = {
      schemaVersion: 1,
      meta: { slug: "session-1" },
      scenes: [],
      annotations: [],
    } as any;
    const annotations = [{ id: "new", comment: "x".repeat(1000) }] as any;

    expect(replayJsonSize(quickShareReplay(session, annotations))).toBeGreaterThan(
      replayJsonSize(session),
    );
  });
});
