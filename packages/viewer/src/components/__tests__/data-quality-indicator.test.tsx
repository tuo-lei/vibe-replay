// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataQualityIndicator } from "../DataQualityIndicator";

describe("DataQualityIndicator", () => {
  it("names the metric context for assistive technology", () => {
    render(<DataQualityIndicator title="Cost estimate is unavailable\nModel is unknown" />);

    expect(
      screen.getByRole("button", {
        name: /Show data quality details: Cost estimate is unavailable/,
      }),
    ).toBeTruthy();
  });
});
