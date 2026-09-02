// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionLoadingBanner } from "../SessionDataProgress";

describe("SessionLoadingBanner", () => {
  it("shows processed and total counts for enrichment progress", () => {
    render(
      <SessionLoadingBanner
        title="Loading more local session details"
        description="Enriching sessions"
        status={{ running: true, processed: 3, total: 10, updated: 0 }}
      />,
    );

    expect(screen.getByText("3/10")).toBeTruthy();
  });
});
