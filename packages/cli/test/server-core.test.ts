import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import {
  getErrorMessage,
  requireSlug,
  resolveGenerateInputs,
  safeSlug,
} from "../src/server-core.js";

function session(project: string): SessionInfo {
  return {
    provider: "cursor",
    sessionId: "session-1",
    slug: "session-1",
    project,
    cwd: project,
    version: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: "session.jsonl",
    filePaths: ["session.jsonl"],
    firstPrompt: "prompt",
  };
}

describe("server core helpers", () => {
  it("accepts simple slugs and rejects path traversal", () => {
    expect(safeSlug("session-2026_05.json")).toBe("session-2026_05.json");
    expect(safeSlug("nested/session.json")).toBeNull();
    expect(safeSlug("../session.json")).toBeNull();
    expect(safeSlug(".")).toBeNull();
    expect(safeSlug("..")).toBeNull();
    expect(safeSlug(undefined)).toBeNull();
  });

  it("returns the shared 400 error shape for invalid slugs", () => {
    expect(requireSlug("abc123")).toEqual({ slug: "abc123" });
    expect(requireSlug("../../abc123")).toEqual({ error: "slug parameter is required" });
  });

  it("normalizes thrown values into response messages", () => {
    expect(getErrorMessage(new Error("disk failed"))).toBe("disk failed");
    expect(getErrorMessage("plain failure")).toBe("plain failure");
    expect(getErrorMessage({ message: "not an Error" })).toBe("Unknown error");
  });

  it.skipIf(process.platform !== "win32")(
    "matches a Windows session project despite slash and casing differences",
    () => {
      const home = homedir();
      const discovered = session("~/Code/vibe-replay");
      const requestedProject = `${home.replaceAll("\\", "/").toLowerCase()}/Code/vibe-replay`;
      const result = resolveGenerateInputs(
        {
          provider: "cursor",
          filePaths: [],
          toolPaths: [],
          sessionSlug: "session-1",
          sessionProject: requestedProject,
        },
        [discovered],
      );

      expect(result).toMatchObject({ ok: true, value: { sessionInfo: discovered } });
    },
  );
});
