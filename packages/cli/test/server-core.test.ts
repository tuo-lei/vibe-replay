import { describe, expect, it } from "vitest";
import { getErrorMessage, requireSlug, safeSlug } from "../src/server-core.js";

describe("server core helpers", () => {
  it("accepts simple slugs and rejects path traversal", () => {
    expect(safeSlug("session-2026_05.json")).toBe("session-2026_05.json");
    expect(safeSlug("nested/session.json")).toBeNull();
    expect(safeSlug("../session.json")).toBeNull();
    expect(safeSlug(".")).toBeNull();
    expect(safeSlug("..")).toBeNull();
    expect(safeSlug(undefined)).toBeNull();
  });

  it("returns the shared 400 error shape for invalid slugs", () => {
    expect(requireSlug("abc123")).toEqual({ slug: "abc123" });
    expect(requireSlug("../../abc123")).toEqual({ error: "slug parameter is required" });
  });

  it("normalizes thrown values into response messages", () => {
    expect(getErrorMessage(new Error("disk failed"))).toBe("disk failed");
    expect(getErrorMessage("plain failure")).toBe("plain failure");
    expect(getErrorMessage({ message: "not an Error" })).toBe("Unknown error");
  });
});
