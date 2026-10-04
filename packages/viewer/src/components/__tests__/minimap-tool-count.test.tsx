// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Minimap from "../Minimap";

afterEach(cleanup);

it("shows child invocation counts and names without counting the exec container", () => {
  render(
    <Minimap
      currentIndex={1}
      onSeek={() => {}}
      scenes={[
        { type: "user-prompt", content: "Update and check" },
        {
          type: "tool-call",
          toolName: "exec",
          input: {},
          result: "batch output",
          isToolContainer: true,
        },
        { type: "tool-call", toolName: "Edit", input: {}, result: "", resultUnavailable: true },
        { type: "tool-call", toolName: "Bash", input: {}, result: "", resultUnavailable: true },
      ]}
    />,
  );
  expect(screen.getByText("2 tools")).toBeDefined();
  expect(screen.getByText("Edit, Bash")).toBeDefined();
  expect(screen.queryByText("3 tools")).toBeNull();
  expect(screen.queryByText("exec, Edit, Bash")).toBeNull();
});
