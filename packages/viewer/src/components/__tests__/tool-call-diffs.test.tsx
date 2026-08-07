// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Scene } from "../../types";
import ToolCallBlock from "../ToolCallBlock";

afterEach(cleanup);

describe("ToolCallBlock multi-file diffs", () => {
  it("renders every changed file while retaining the primary diff", () => {
    const diffs = [
      { filePath: "src/app.ts", oldContent: "old", newContent: "new" },
      { filePath: "src/auth.ts", oldContent: "before", newContent: "after" },
    ];
    const scene: Extract<Scene, { type: "tool-call" }> = {
      type: "tool-call",
      toolName: "Edit",
      input: {},
      result: "Done",
      diff: diffs[0],
      diffs,
    };

    render(<ToolCallBlock scene={scene} isActive={false} />);

    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("src/auth.ts")).toBeTruthy();
  });
});
