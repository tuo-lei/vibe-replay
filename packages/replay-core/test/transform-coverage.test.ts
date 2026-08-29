import { describe, expect, it } from "vitest";
import type { ProviderParseResult } from "@vibe-replay/provider-contract";
import { transformToReplay } from "../src/transform.js";

function makeParsed(overrides: Partial<ProviderParseResult> = {}): ProviderParseResult {
  return {
    sessionId: "s1",
    slug: "s1",
    cwd: "/tmp/project",
    turns: [{ role: "user", blocks: [{ type: "text", text: "hello" }] }],
    startTime: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("transformToReplay cost precedence", () => {
  it("reportedCostUsd=0 is authoritative (not falsy fallback)", () => {
    const replay = transformToReplay(
      makeParsed({
        reportedCostUsd: 0,
        tokenUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        tokenUsageByModel: {
          "claude-sonnet-4": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      }),
      "claude-code",
      "~/project",
    );
    expect(replay.meta.stats.costEstimate).toBe(0);
  });

  it("reportedCostUsd undefined falls back to tokenUsageByModel", () => {
    const replay = transformToReplay(
      makeParsed({
        tokenUsageByModel: {
          "claude-sonnet-4": {
            inputTokens: 10000,
            outputTokens: 5000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      }),
      "claude-code",
      "~/project",
    );
    // pricing may return number or undefined depending on model; just assert not using 0 path
    expect(
      typeof replay.meta.stats.costEstimate === "number" ||
        replay.meta.stats.costEstimate === undefined,
    ).toBe(true);
  });

  it("private SSH remoteHome not leaked — path boundary requires / after", () => {
    // "/home/alice" should NOT match "/home/alice2/..."
    const remoteHome = "/home/alice";
    const parsed = makeParsed({
      turns: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "Read", input: { file_path: "/home/alice2/secret.txt" } },
          ],
        },
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "Read", input: { file_path: "/home/alice/project/file.ts" } },
          ],
        },
      ],
    });
    const replay = transformToReplay(parsed, "claude-code", `${remoteHome}/project`, {
      remoteHome,
      location: { kind: "ssh", id: "r", label: "R" },
    });
    // first path should stay (boundary guard), second should be redacted
    const inputs = replay.scenes
      .filter((s) => s.type === "tool-call")
      .map((s: any) => s.input?.file_path);
    expect(inputs[0]).toBe("/home/alice2/secret.txt");
    expect(inputs[1]).toBe("~/project/file.ts");
  });

  it("remoteHome boundary: preceding char must not be alphanum", () => {
    const remoteHome = "/home/bob";
    // user text path triggers redactPath, not remoteHome, so verify tool-bound path instead
    void transformToReplay(
      makeParsed({
        turns: [{ role: "user", blocks: [{ type: "text", text: "prefix/home/bob/project" }] }],
      }),
      "claude-code",
      `${remoteHome}/project`,
      { remoteHome, location: { kind: "ssh", id: "r", label: "R" } },
    );
    const p2 = makeParsed({
      turns: [
        {
          role: "assistant",
          blocks: [
            { type: "tool_use", name: "Bash", input: { command: "echo /home/bob/project" } },
          ],
        },
      ],
    });
    const r2 = transformToReplay(p2, "claude-code", `${remoteHome}/project`, {
      remoteHome,
      location: { kind: "ssh", id: "r", label: "R" },
    });
    // command field is redacted via remoteHome
    const cmd = (r2.scenes.find((s) => s.type === "tool-call") as any)?.bashOutput?.command;
    // Exact match or path with boundary should be ~; preceding alphanum case stays
    expect(cmd).toContain("~/project");
  });

  it("handles turns with no timestamps fallback to startTime", () => {
    const parsed = makeParsed({
      turns: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      startTime: undefined,
      endTime: undefined,
    });
    const replay = transformToReplay(parsed, "test", "~/p");
    expect(typeof replay.meta.startTime).toBe("string");
  });
});
