import { describe, expect, it } from "vitest";
import { isHermesSessionId } from "../src/hermes/sqlite.js";

describe("isHermesSessionId", () => {
  it("recognizes timestamp-prefixed session ids", () => {
    expect(isHermesSessionId("20260804_202053_7b0f72")).toBe(true);
    expect(isHermesSessionId("20260822_222249_29dd93")).toBe(true);
  });

  it("recognizes legacy session_ prefixed ids", () => {
    expect(isHermesSessionId("session_abc123")).toBe(true);
  });

  it("rejects unrelated strings", () => {
    expect(isHermesSessionId("ses_111")).toBe(false);
    expect(isHermesSessionId("/some/path.jsonl")).toBe(false);
    expect(isHermesSessionId("")).toBe(false);
  });
});
