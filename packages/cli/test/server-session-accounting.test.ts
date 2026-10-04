import { expect, it } from "vitest";
import type { ParsedTurn } from "../src/types.js";
import { countSessionStats, extractPromptPreviewsFromTurns } from "../src/server-session-stats.js";

it("keeps host triggers and exec evidence out of source enrichment counts and previews", () => {
  const turns: ParsedTurn[] = [
    {
      role: "user",
      subtype: "context-injection",
      blocks: [{ type: "text", text: "Injected instructions" }],
    },
    { role: "user", blocks: [{ type: "text", text: "Update both files" }] },
    {
      role: "user",
      subtype: "automation-trigger",
      blocks: [{ type: "text", text: "Automatic status check" }],
    },
    {
      role: "assistant",
      blocks: [
        { type: "tool_use", id: "batch", name: "exec", input: {}, _isToolContainer: true },
        { type: "tool_use", id: "child-1", name: "Edit", input: {} },
        { type: "tool_use", id: "child-2", name: "Bash", input: {} },
      ],
    },
  ];
  expect(countSessionStats(turns)).toEqual({ promptCount: 1, toolCallCount: 2 });
  expect(extractPromptPreviewsFromTurns(turns)).toEqual(["Update both files"]);
});
