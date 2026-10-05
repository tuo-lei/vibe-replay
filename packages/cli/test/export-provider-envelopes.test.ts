import { expect, it } from "vitest";
import { extractPhases } from "../src/formatters/github.js";
import { cleanPromptText } from "../src/clean-prompt.js";
import type { Scene } from "../src/types.js";

const response: Scene = { type: "text-response", content: "Following response" };
it.each(["claude-code", "pi", "opencode", "cursor"])(
  "preserves literal Codex-named tags and their following scenes for %s",
  (provider) => {
    for (const content of [
      "<environment_context>Literal user instruction</environment_context>",
      "<environment_context>Literal unclosed instruction",
      "<developer_instructions>Literal instruction</developer_instructions>",
    ]) {
      const scenes: Scene[] = [{ type: "user-prompt", content }, response];
      expect(extractPhases(scenes, provider)).toMatchObject([
        { prompt: content, scenes: [response] },
      ]);
      expect(extractPhases(scenes)).toMatchObject([{ prompt: content, scenes: [response] }]);
    }
  },
);

it("cleans Codex host envelopes while retaining the human request and response", () => {
  const scenes: Scene[] = [
    {
      type: "user-prompt",
      content: "<environment_context>Host metadata</environment_context>\nActual request",
    },
    response,
  ];
  expect(extractPhases(scenes, "codex")).toMatchObject([
    { prompt: "Actual request", scenes: [response] },
  ]);
});

it("keeps literal-tag instructions in provider-independent prompt previews", () => {
  expect(
    cleanPromptText("<environment_context>Literal user instruction</environment_context>"),
  ).toBe("Literal user instruction");
  expect(cleanPromptText("<environment_context>Literal unclosed instruction")).toBe(
    "Literal unclosed instruction",
  );
});
