import { describe, expect, it } from "vitest";
import { PROVIDER_API_VERSION } from "../src/index.js";

describe("provider-contract public surface", () => {
  it("pins the provider API version to a stable integer", () => {
    // This is a deliberate change-detector: bumping the contract version is a
    // breaking change for in-repo providers and should be intentional.
    expect(PROVIDER_API_VERSION).toBe(1);
    expect(Number.isInteger(PROVIDER_API_VERSION)).toBe(true);
  });
});
