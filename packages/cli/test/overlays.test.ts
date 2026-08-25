import { describe, expect, it } from "vitest";
import { sessionForExternalOutput } from "../src/overlays.js";
import type { ReplaySession } from "../src/types.js";

function replay(location?: ReplaySession["meta"]["location"]): ReplaySession {
  return {
    meta: {
      sessionId: "session",
      slug: "session",
      provider: "codex",
      location,
      gitRepo: "private-org/private-repo",
      startTime: "2026-08-25T00:00:00.000Z",
      cwd: "~/project",
      project: "~/project",
      stats: { sceneCount: 1, userPrompts: 1, toolCalls: 0 },
    },
    scenes: [{ type: "user-prompt", content: "Inspect the project" }],
  };
}

describe("sessionForExternalOutput", () => {
  it("removes repository identity from SSH replay exports", () => {
    const source = replay({ kind: "ssh", id: "remote-dev", label: "Remote dev" });
    const external = sessionForExternalOutput(source);

    expect(external.meta.gitRepo).toBeUndefined();
    expect(source.meta.gitRepo).toBe("private-org/private-repo");
  });

  it("preserves repository identity for local replay exports", () => {
    expect(sessionForExternalOutput(replay()).meta.gitRepo).toBe("private-org/private-repo");
  });
});
