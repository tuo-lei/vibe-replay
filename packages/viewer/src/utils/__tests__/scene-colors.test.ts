import { describe, expect, it } from "vitest";
import type { Scene } from "../../types";
import { sceneTone, sceneToneClasses } from "../scene-colors";

function scene(partial: Partial<Scene>): Scene {
  return {
    type: "text-response",
    content: "response",
    ...partial,
  } as Scene;
}

describe("scene semantic colors", () => {
  it.each([
    ["user-prompt", "user"],
    ["text-response", "response"],
    ["tool-call", "tool"],
    ["thinking", "thinking"],
    ["compaction-summary", "context"],
    ["context-injection", "context"],
  ] as const)("maps %s to the %s tone", (type, tone) => {
    expect(sceneTone(scene({ type }))).toBe(tone);
  });

  it("maps failed work to error and truncated work to warning", () => {
    expect(
      sceneTone(
        scene({ type: "tool-call", toolName: "Bash", input: {}, result: "", isError: true }),
      ),
    ).toBe("error");
    expect(sceneTone(scene({ type: "text-response", isTruncated: true }))).toBe("warning");
  });

  it("keeps the normal context tone distinct from the error tone", () => {
    expect(sceneToneClasses(scene({ type: "compaction-summary" })).text).toBe(
      "text-terminal-context",
    );
    expect(
      sceneToneClasses(scene({ type: "tool-call", toolName: "Read", input: {}, result: "" })).text,
    ).toBe("text-terminal-tool");
  });
});
