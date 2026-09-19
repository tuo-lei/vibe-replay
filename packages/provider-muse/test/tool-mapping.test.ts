import { describe, expect, it } from "vitest";
import { mapMuseToolArgs, mapMuseToolName } from "../src/muse/tool-mapping.js";

describe("mapMuseToolName", () => {
  it("maps lowercase built-ins to canonical names", () => {
    expect(mapMuseToolName("exec")).toBe("Bash");
    expect(mapMuseToolName("read")).toBe("Read");
    expect(mapMuseToolName("edit")).toBe("Edit");
    expect(mapMuseToolName("write")).toBe("Write");
  });

  it("passes namespaced agent tools through untouched", () => {
    expect(mapMuseToolName("memory_search")).toBe("memory_search");
    expect(mapMuseToolName("subagent.spawn")).toBe("subagent.spawn");
    expect(mapMuseToolName("tool_search.load_tool_namespace")).toBe(
      "tool_search.load_tool_namespace",
    );
  });
});

describe("mapMuseToolArgs", () => {
  it("maps edit fields to canonical file_path/old_string/new_string", () => {
    expect(
      mapMuseToolArgs("edit", {
        path: "/tmp/a.ts",
        old_text: "const x = 1;",
        new_text: "const x = 2;",
      }),
    ).toEqual({
      file_path: "/tmp/a.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
  });

  it("maps write fields to canonical file_path/content", () => {
    expect(mapMuseToolArgs("write", { path: "/tmp/b.ts", content: "hello" })).toEqual({
      file_path: "/tmp/b.ts",
      content: "hello",
    });
  });

  it("maps read path to file_path", () => {
    expect(mapMuseToolArgs("read", { path: "/tmp/c.ts" })).toEqual({ file_path: "/tmp/c.ts" });
  });

  it("leaves exec args (already canonical) alone", () => {
    expect(mapMuseToolArgs("exec", { command: "pnpm test" })).toEqual({ command: "pnpm test" });
  });

  it("preserves unknown extra fields", () => {
    expect(mapMuseToolArgs("edit", { path: "/tmp/a.ts", extra: 1 })).toEqual({
      file_path: "/tmp/a.ts",
      extra: 1,
    });
  });

  it("passes unknown tools through untouched", () => {
    const args = { queries: ["a"] };
    expect(mapMuseToolArgs("memory_search", args)).toBe(args);
  });
});
