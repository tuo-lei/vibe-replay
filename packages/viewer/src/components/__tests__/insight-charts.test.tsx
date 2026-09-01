// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextBreakdownChart, TokenBreakdownChart, TurnDurationChart } from "../InsightCharts";

afterEach(cleanup);

describe("InsightCharts", () => {
  it("shows a compact total and token category breakdown", () => {
    render(
      <TokenBreakdownChart
        breakdown={{ input: 100, output: 50, cacheRead: 200, cacheCreation: 10 }}
      />,
    );

    expect(screen.getByText("Total")).toBeDefined();
    expect(screen.getByText("Cache Read")).toBeDefined();
    expect(screen.getByText("Cache Write")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Input (uncached)")).toBeDefined();
  });

  it("renders duration percentiles alongside the turn distribution", () => {
    render(
      <TurnDurationChart
        histogram={{
          buckets: [
            { label: "<30s", count: 1, pct: 50 },
            { label: "30s-1m", count: 1, pct: 50 },
          ],
          percentiles: { p50Ms: 20_000, p75Ms: 30_000, p90Ms: 40_000 },
          totalTurns: 2,
        }}
      />,
    );

    expect(screen.getByText("P50")).toBeDefined();
    expect(screen.getByText("P75")).toBeDefined();
    expect(screen.getByText("P90")).toBeDefined();
    expect(screen.getByText(/recorded and estimated turn durations/)).toBeDefined();
  });

  it("renders provider-estimated context categories without raw content", () => {
    render(
      <ContextBreakdownChart
        breakdown={{
          source: "cursor-prompt-token-breakdown",
          scope: "latest-snapshot",
          totalEstimatedTokens: 20_000,
          contextLimit: 100_000,
          components: [
            { id: "system-prompt", estimatedTokens: 3_000 },
            { id: "mcp-tool-definitions", estimatedTokens: 2_000 },
            { id: "conversation", estimatedTokens: 15_000 },
          ],
        }}
      />,
    );

    expect(screen.getByText("System prompt")).toBeDefined();
    expect(screen.getByText("MCP & dynamic tools")).toBeDefined();
    expect(screen.getByText("20k tokens / 100k")).toBeDefined();
    expect(screen.getByText(/latest context snapshot/)).toBeDefined();
  });

  it("renders byte-only context metadata and definition details", () => {
    render(
      <ContextBreakdownChart
        breakdown={{
          source: "claude-cowork-metadata",
          scope: "session-metadata",
          components: [
            { id: "system-prompt", contentBytes: 2_048, itemCount: 1 },
            {
              id: "mcp-tool-definitions",
              contentBytes: 4_096,
              itemCount: 3,
              availableItemCount: 5,
              descriptionBytes: 1_024,
              schemaBytes: 2_048,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("6.0 KiB")).toBeDefined();
    expect(screen.getByText("3 items / 5 available")).toBeDefined();
    expect(screen.getByText("1.0 KiB descriptions · 2.0 KiB schemas")).toBeDefined();
    expect(screen.getByText(/bytes are not model-token counts/)).toBeDefined();
  });
});
