import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { __testables } from "../src/server.js";

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

describe("server project path normalization", () => {
  it.skipIf(process.platform !== "win32")(
    "redacts Windows home paths regardless of separator or casing",
    () => {
      const home = homedir();
      const project = `${home.replaceAll("\\", "/").toLowerCase()}/Code/vibe-replay`;
      const [normalized] = __testables.normalizeSessionProjectsForHome([session(project)], home);

      expect(normalized.project).toBe("~/Code/vibe-replay");
    },
  );

  it("recognizes both tilde separator styles as filesystem project keys", () => {
    expect(__testables.isFilesystemProjectKey("~/Code/vibe-replay")).toBe(true);
    expect(__testables.isFilesystemProjectKey("~\\Code\\vibe-replay")).toBe(true);
  });
});
