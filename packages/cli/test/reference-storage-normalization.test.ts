import { expect, it } from "vitest";
import { resolveSessionReference } from "../src/session-workflows.js";
import type { SessionInfo } from "../src/types.js";

it.each(["session", "composerData"])(
  "normalizes %s storage references for sessions selection",
  (marker) => {
    const path = "/tmp/shared-state.db";
    const sessions = ["first-native-id", "second-native-id"].map(
      (id) =>
        ({
          provider: "cursor",
          sessionId: id,
          slug: id,
          filePath: `${path}#${marker}:${id}`,
          filePaths: [],
          project: "/tmp",
          cwd: "/tmp",
          version: "",
          timestamp: "",
          firstPrompt: id,
          lineCount: 1,
          fileSize: 1,
        }) satisfies SessionInfo,
    );
    expect(() => resolveSessionReference(sessions, path)).toThrow("Ambiguous");
    expect(resolveSessionReference(sessions, `${path}#${marker}:second-native-id`)).toBe(
      sessions[1],
    );
    expect(resolveSessionReference([sessions[1]], path)).toBe(sessions[1]);
  },
);
