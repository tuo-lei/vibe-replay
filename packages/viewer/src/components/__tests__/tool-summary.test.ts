import { describe, expect, it } from "vitest";
import { shortenScalarSummary, summarizeInput } from "../ToolCallBlock";

describe("summarizeInput", () => {
  it("uses file_path for file tools", () => {
    expect(summarizeInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeInput("Write", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeInput("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeInput("MultiEdit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });

  it("uses notebook_path for NotebookEdit", () => {
    expect(summarizeInput("NotebookEdit", { notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
  });

  it("Grep formats pattern + path and trims trailing space when path is empty", () => {
    expect(summarizeInput("Grep", { pattern: "foo", path: "src" })).toBe("/foo/ src");
    expect(summarizeInput("Grep", { pattern: "foo" })).toBe("/foo/");
  });

  describe("Bash", () => {
    it("prefers command over description", () => {
      expect(summarizeInput("Bash", { command: "ls", description: "list files" })).toBe("ls");
    });

    it("falls back to description when command is missing", () => {
      expect(summarizeInput("Bash", { description: "list files" })).toBe("list files");
    });

    it("collapses multi-line commands to one line", () => {
      const input = { command: "for i in 1 2 3; do\n  echo $i\ndone" };
      expect(summarizeInput("Bash", input)).toBe("for i in 1 2 3; do echo $i done");
    });

    it("truncates very long commands with ellipsis", () => {
      const longCmd = `echo ${"x".repeat(300)}`;
      const result = summarizeInput("Bash", { command: longCmd });
      expect(result.length).toBeLessThanOrEqual(201); // 200 + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });
  });

  describe("Agent / Task", () => {
    it("joins subagent_type and description", () => {
      expect(summarizeInput("Agent", { subagent_type: "Explore", description: "find X" })).toBe(
        "Explore — find X",
      );
    });

    it("falls back to description alone when subagent_type is missing", () => {
      expect(summarizeInput("Task", { description: "do thing" })).toBe("do thing");
    });
  });

  describe("TodoWrite", () => {
    it("returns empty string when no todos", () => {
      expect(summarizeInput("TodoWrite", { todos: [] })).toBe("");
      expect(summarizeInput("TodoWrite", {})).toBe("");
    });

    it("shows count alone when nothing in progress", () => {
      const todos = [
        { status: "completed", content: "a" },
        { status: "pending", content: "b" },
      ];
      expect(summarizeInput("TodoWrite", { todos })).toBe("2 todos");
    });

    it("shows count + in_progress content when one is active", () => {
      const todos = [
        { status: "completed", content: "a" },
        { status: "in_progress", content: "b" },
        { status: "pending", content: "c" },
      ];
      expect(summarizeInput("TodoWrite", { todos })).toBe("3 todos · b");
    });
  });

  it("uses shortenScalarSummary fallback for unknown tools (e.g. mcp__*)", () => {
    expect(summarizeInput("mcp__server__tool", { url: "https://x.com" })).toBe("https://x.com");
  });
});

describe("shortenScalarSummary", () => {
  it("prefers url over other keys", () => {
    expect(shortenScalarSummary({ url: "https://a.com", path: "/x", name: "n" })).toBe(
      "https://a.com",
    );
  });

  it("falls back through preferred keys: path, file_path, query, name, id", () => {
    expect(shortenScalarSummary({ path: "/x", name: "n" })).toBe("/x");
    expect(shortenScalarSummary({ file_path: "/x", name: "n" })).toBe("/x");
    expect(shortenScalarSummary({ query: "q", name: "n" })).toBe("q");
    expect(shortenScalarSummary({ name: "n", id: "i" })).toBe("n");
    expect(shortenScalarSummary({ id: "i" })).toBe("i");
  });

  it("ignores empty strings when picking a preferred key", () => {
    expect(shortenScalarSummary({ url: "", path: "/x" })).toBe("/x");
  });

  it("ignores non-string preferred values", () => {
    expect(shortenScalarSummary({ url: 42, path: "/x" })).toBe("/x");
  });

  it("falls back to joined string values when no preferred key matches", () => {
    expect(shortenScalarSummary({ foo: "a", bar: "b", baz: 99 })).toBe("a b");
  });

  it("truncates the preferred value at 80 chars", () => {
    const long = "x".repeat(200);
    expect(shortenScalarSummary({ url: long }).length).toBe(80);
  });

  it("returns empty string when input has no usable values", () => {
    expect(shortenScalarSummary({ count: 5, active: true })).toBe("");
  });
});
