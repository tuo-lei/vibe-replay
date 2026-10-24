import { describe, expect, it } from "vitest";
import { parseSessionFromDb } from "../src/opencode/parser.js";
import { buildOpencodeDb } from "./helpers/db.js";

describe("OpenCode OTel metadata", () => {
  it("preserves the timestamp of the first assistant usage message per turn", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_otel", slug: "otel", directory: "/tmp/project" }],
      messages: [
        {
          id: "msg_user",
          sessionId: "ses_otel",
          role: "user",
          timeCreated: 1_800_000_001_000,
          parts: [{ type: "text", text: "Prompt" }],
        },
        {
          id: "msg_assistant",
          sessionId: "ses_otel",
          role: "assistant",
          modelID: "fixture-model",
          timeCreated: 1_800_000_002_000,
          tokens: { input: 10, output: 2 },
          parts: [{ type: "text", text: "Response" }],
        },
      ],
    });

    try {
      const parsed = parseSessionFromDb(db, "ses_otel");
      expect(parsed.turnStats?.[0]).toMatchObject({
        timestamp: "2027-01-15T08:00:02.000Z",
      });
    } finally {
      db.close();
    }
  });
});
