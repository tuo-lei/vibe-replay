import { describe, expect, it } from "vitest";
import { expandUserPath } from "../src/utils.js";

describe("expandUserPath", () => {
  it.each(["~/sessions/replay.jsonl", "~\\sessions\\replay.jsonl"])(
    "expands %s with the supplied home directory",
    (path) => {
      expect(expandUserPath(path, "C:\\Users\\TuoLei", "win32")).toBe(
        "C:\\Users\\TuoLei\\sessions\\replay.jsonl",
      );
    },
  );

  it("expands the home directory by itself", () => {
    expect(expandUserPath("~", "C:\\Users\\TuoLei", "win32")).toBe("C:\\Users\\TuoLei");
  });

  it("uses POSIX separators for POSIX home paths", () => {
    expect(expandUserPath("~/sessions/replay.jsonl", "/home/TuoLei", "linux")).toBe(
      "/home/TuoLei/sessions/replay.jsonl",
    );
  });

  it.each(["C:\\sessions\\replay.jsonl", "/tmp/replay.jsonl", "~other/replay.jsonl"])(
    "leaves non-home paths unchanged: %s",
    (path) => {
      expect(expandUserPath(path, "C:\\Users\\TuoLei")).toBe(path);
    },
  );
});
