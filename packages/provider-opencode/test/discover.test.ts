import { describe, expect, it } from "vitest";
import { listSessionsFromDb } from "../src/opencode/discover.js";
import { buildOpencodeDb } from "./helpers/db.js";

describe("opencode discover", () => {
  it("lists non-subagent sessions with discovery stats", async () => {
    const db = await buildOpencodeDb({
      session: [
        {
          id: "ses_main",
          slug: "swift-eagle",
          title: "Add opencode support",
          directory: "/Users/test/project",
          model: JSON.stringify({ id: "deepseek-v4-flash-free", providerID: "opencode" }),
          timeCreated: 1_800_000_000_000,
          timeUpdated: 1_800_000_100_000,
        },
        {
          id: "ses_sub",
          slug: "sub-agent",
          directory: "/Users/test/project",
          timeCreated: 1_800_000_000_000,
          timeUpdated: 1_800_000_050_000,
        },
      ],
      messages: [
        {
          id: "m1",
          sessionId: "ses_main",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [{ type: "text", text: "Please add opencode support" }],
        },
        {
          id: "m2",
          sessionId: "ses_main",
          role: "assistant",
          timeCreated: 1_800_000_020_000,
          finish: "tool-calls",
          parts: [
            { type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } },
            { type: "tool", tool: "edit", callID: "c2", state: { status: "completed" } },
          ],
        },
        {
          id: "m3",
          sessionId: "ses_main",
          role: "user",
          timeCreated: 1_800_000_030_000,
          parts: [{ type: "text", text: "Now the second prompt" }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);

      // The sub-agent session would need parent_id; our helper doesn't set it,
      // so it is filtered by the missing first-prompt/text requirement instead.
      const main = sessions.find((s) => s.sessionId === "ses_main");
      expect(main).toBeDefined();
      expect(main).toMatchObject({
        provider: "opencode",
        slug: "swift-eagle",
        title: "Add opencode support",
        project: "/Users/test/project",
        cwd: "/Users/test/project",
        model: "deepseek-v4-flash-free",
        firstPrompt: "Please add opencode support",
        promptCount: 2,
        toolCallCount: 2,
        editCountEst: 1,
        hasSqlite: true,
      });
      expect(main?.filePath).toContain("#session:ses_main");
      expect(main?.durationMsEst).toBe(100_000);
    } finally {
      db.close();
    }
  });

  it("skips sessions without a user text prompt", async () => {
    const db = await buildOpencodeDb({
      session: [{ id: "ses_empty", slug: "empty", directory: "/Users/test/project" }],
      messages: [
        {
          id: "me1",
          sessionId: "ses_empty",
          role: "user",
          timeCreated: 1_800_000_010_000,
          parts: [{ type: "file", url: "x.png", mime: "image/png" }],
        },
      ],
    });

    try {
      const sessions = listSessionsFromDb(db);
      expect(sessions).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
