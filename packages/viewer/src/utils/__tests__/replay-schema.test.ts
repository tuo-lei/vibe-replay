import { describe, expect, it } from "vitest";
import { REPLAY_SCHEMA_VERSION } from "../../types";
import { parseReplaySession } from "../replaySchema";

function replay(overrides: Record<string, unknown> = {}) {
  return {
    meta: { sessionId: "session-1", provider: "claude-code" },
    scenes: [{ type: "user-prompt", content: "Hello" }],
    ...overrides,
  };
}

describe("parseReplaySession", () => {
  it("accepts legacy replays without a schema version", () => {
    expect(parseReplaySession(replay()).schemaVersion).toBeUndefined();
  });

  it("accepts the current replay schema", () => {
    expect(parseReplaySession(replay({ schemaVersion: REPLAY_SCHEMA_VERSION })).schemaVersion).toBe(
      REPLAY_SCHEMA_VERSION,
    );
  });

  it("rejects future replay schemas with a descriptive error", () => {
    expect(() => parseReplaySession(replay({ schemaVersion: REPLAY_SCHEMA_VERSION + 1 }))).toThrow(
      "Unsupported replay schema version",
    );
  });

  it("rejects malformed scene envelopes", () => {
    expect(() => parseReplaySession(replay({ scenes: [{ type: "future-scene" }] }))).toThrow(
      "unsupported scene at index 0",
    );
  });

  it("rejects scenes missing renderer-required fields", () => {
    expect(() => parseReplaySession(replay({ scenes: [{ type: "user-prompt" }] }))).toThrow(
      "missing string content",
    );
    expect(() =>
      parseReplaySession(replay({ scenes: [{ type: "tool-call", toolName: "Read" }] })),
    ).toThrow("missing tool input");
    expect(() =>
      parseReplaySession(
        replay({ scenes: [{ type: "tool-call", toolName: "Read", input: {}, result: 42 }] }),
      ),
    ).toThrow("missing tool result");
  });
});
