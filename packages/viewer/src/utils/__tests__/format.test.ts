import { describe, expect, it } from "vitest";
import { normalizePathForDisplay, pathSegments, shortName } from "../format";

describe("path display helpers", () => {
  it("supports both POSIX and Windows separators", () => {
    expect(normalizePathForDisplay("C:\\Users\\TuoLei\\app")).toBe("C:/Users/TuoLei/app");
    expect(pathSegments("C:\\Users\\TuoLei\\app")).toEqual(["C:", "Users", "TuoLei", "app"]);
    expect(shortName("C:\\Users\\TuoLei\\app")).toBe("app");
    expect(shortName("/Users/TuoLei/app")).toBe("app");
  });
});
