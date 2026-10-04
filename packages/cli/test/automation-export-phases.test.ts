import { expect, it } from "vitest";
import {
  extractPhases,
  generateGitHubMarkdown,
  generateGitHubSvg,
} from "../src/formatters/github.js";
import type { ReplaySession } from "../src/types.js";

it("starts Codex automation export phases without counting them as human prompts", () => {
  const replay: ReplaySession = {
    meta: {
      sessionId: "automatic",
      slug: "automatic",
      provider: "codex",
      cwd: "/repo",
      project: "/repo",
      stats: {
        sceneCount: 3,
        userPrompts: 0,
        automationTriggerCount: 1,
        toolCalls: 1,
        thinkingBlocks: 0,
      },
    },
    scenes: [
      {
        type: "context-injection",
        injectionType: "automation",
        content:
          "<heartbeat><automation_id>review</automation_id><instructions>Check the current PR.</instructions></heartbeat>",
      },
      {
        type: "tool-call",
        toolName: "Bash",
        input: { command: "pnpm test" },
        result: "Passed",
        isError: false,
      },
      { type: "text-response", content: "All tests passed successfully" },
    ],
  };
  const phases = extractPhases(replay.scenes, "codex");
  expect(phases).toHaveLength(1);
  expect(phases[0].prompt).toBe("Automation: Check the current PR.");
  expect(phases[0].scenes).toEqual(replay.scenes.slice(1));
  expect(phases[0].actions).toEqual([
    { kind: "run", command: "pnpm test", passed: true },
    { kind: "text", summary: "All tests passed successfully" },
  ]);
  expect(generateGitHubMarkdown(replay)).toContain("Automation: Check the current PR.");
  expect(generateGitHubSvg(replay)).toContain("Bash (pnpm) 1");
  expect(generateGitHubSvg(replay)).toContain("All tests passed successfully");
  expect(generateGitHubMarkdown(replay)).toContain("0 prompts");
  expect(generateGitHubSvg(replay)).toContain("Check the current PR.");
  expect(extractPhases(replay.scenes, "pi")).toEqual([]);
});
