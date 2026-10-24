import { describe, expect, it } from "vitest";
import { parseCodexLines } from "../src/codex/parser.js";

describe("Codex OTel metadata", () => {
  it("preserves the recorded usage snapshot timestamp on turn stats", () => {
    const records = [
      {
        timestamp: "2026-04-26T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "otel-timestamp", cwd: "/tmp/project" },
      },
      {
        timestamp: "2026-04-26T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "First prompt" },
      },
      {
        timestamp: "2026-04-26T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 },
          },
        },
      },
      {
        timestamp: "2026-04-26T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Next prompt" },
      },
    ];

    const parsed = parseCodexLines(records.map((record) => JSON.stringify(record)));

    expect(parsed.turnStats?.[0]).toMatchObject({ timestamp: "2026-04-26T10:00:02.000Z" });
  });
});
