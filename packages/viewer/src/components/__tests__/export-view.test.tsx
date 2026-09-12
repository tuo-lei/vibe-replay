import { describe, expect, it } from "vitest";
import { copyButtonLabel } from "../ExportView";

describe("export copy feedback", () => {
  it("distinguishes copied, failed, and ready states", () => {
    expect(copyButtonLabel(false, false, "Copy MD")).toBe("Copy MD");
    expect(copyButtonLabel(true, false, "Copy MD")).toBe("Copied!");
    expect(copyButtonLabel(false, true, "Copy MD")).toBe("Copy failed");
  });
});
