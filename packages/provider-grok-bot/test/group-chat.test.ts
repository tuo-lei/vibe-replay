import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractGroupMentions,
  formatGroupHeader,
  formatGroupSpeakerMessage,
  isGrokBotGroupChatPayload,
  parseGrokBotGroupWake,
  parseGrokBotSession,
} from "../src/grok-bot/parser.js";
import { transformToReplay } from "./helpers/transform.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const ENG_WAKE = `[Group chat: "Vibe Replay launch" - with Vibe Replay GTM]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: Let's ship the Grok Bot replay provider this week.
Vibe Replay GTM: @Vibe Replay Eng can you confirm the dashboard badge copy?

It's your turn, Vibe Replay Eng. Reply in the room.`;

const GTM_WAKE = `[Group chat: "Vibe Replay launch" - with Vibe Replay Eng]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: Let's ship the Grok Bot replay provider this week.

It's your turn, Vibe Replay GTM. The room is wrapping up after this round.`;

const EMPTY_WAKE = `[Group chat: "Vibe Replay launch" - with Vibe Replay Eng]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
No new messages in the room since your last turn.
It's your turn, Vibe Replay GTM.`;

describe("Grok Bot group-chat wake parser", () => {
  it("detects the [Group chat: prefix", () => {
    expect(isGrokBotGroupChatPayload(ENG_WAKE)).toBe(true);
    expect(isGrokBotGroupChatPayload("[t0u]\nhello")).toBe(false);
    expect(isGrokBotGroupChatPayload("User: not a group wake")).toBe(false);
  });

  it("extracts room title, participants, and ordered speakers from the Eng payload", () => {
    const wake = parseGrokBotGroupWake(ENG_WAKE);
    expect(wake).toMatchObject({
      groupTitle: "Vibe Replay launch",
      withParticipants: ["Vibe Replay GTM"],
      noNewMessages: false,
      turnRecipient: "Vibe Replay Eng",
    });
    expect(wake?.participants).toEqual([
      { name: "Vibe Replay Eng", description: "engineer" },
      { name: "Vibe Replay GTM", description: "go-to-market" },
    ]);
    expect(wake?.messages).toEqual([
      {
        speaker: "User",
        text: "Let's ship the Grok Bot replay provider this week.",
        mentions: [],
      },
      {
        speaker: "Vibe Replay GTM",
        text: "@Vibe Replay Eng can you confirm the dashboard badge copy?",
        mentions: ["@Vibe Replay Eng"],
      },
    ]);
    expect(wake?.mentions).toEqual(["@Vibe Replay Eng"]);
  });

  it("extracts the GTM payload and keeps wrapping-up text out of messages", () => {
    const wake = parseGrokBotGroupWake(GTM_WAKE);
    expect(wake).toMatchObject({
      groupTitle: "Vibe Replay launch",
      withParticipants: ["Vibe Replay Eng"],
      turnRecipient: "Vibe Replay GTM",
    });
    expect(wake?.messages).toEqual([
      {
        speaker: "User",
        text: "Let's ship the Grok Bot replay provider this week.",
        mentions: [],
      },
    ]);
    expect(wake?.messages.some((msg) => /wrapping up/i.test(msg.text))).toBe(false);
    expect(wake?.messages.some((msg) => /your turn/i.test(msg.text))).toBe(false);
  });

  it("marks no-new-messages wakes without inventing speaker turns", () => {
    const wake = parseGrokBotGroupWake(EMPTY_WAKE);
    expect(wake).toMatchObject({
      groupTitle: "Vibe Replay launch",
      noNewMessages: true,
      messages: [],
      turnRecipient: "Vibe Replay GTM",
    });
  });

  it("keeps multiline speaker text and @mentions", () => {
    const wake = parseGrokBotGroupWake(`[Group chat: "Launch room" - with Vibe Replay GTM]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: First line.
Please also check:
- badge copy
Vibe Replay GTM: pinging @Vibe Replay Eng

The room is wrapping up.`);
    expect(wake?.messages).toHaveLength(2);
    expect(wake?.messages[0]).toMatchObject({
      speaker: "User",
      text: "First line.\nPlease also check:\n- badge copy",
    });
    expect(wake?.messages[1].mentions).toEqual(["@Vibe Replay Eng"]);
  });

  it("formats a room header and speaker prefixes for replay text", () => {
    const wake = parseGrokBotGroupWake(ENG_WAKE);
    expect(wake).toBeTruthy();
    if (!wake) return;
    expect(formatGroupHeader(wake)).toBe(
      [
        "Group chat: Vibe Replay launch",
        "Participants: Vibe Replay Eng (engineer), Vibe Replay GTM (go-to-market)",
        "Mentions: @Vibe Replay Eng",
      ].join("\n"),
    );
    expect(formatGroupSpeakerMessage("Vibe Replay GTM", "hello")).toBe(
      "**Vibe Replay GTM:** hello",
    );
    expect(extractGroupMentions("@Vibe Replay Eng please look", ["Vibe Replay Eng"])).toEqual([
      "@Vibe Replay Eng",
    ]);
  });
});

describe("Grok Bot group-chat session parse", () => {
  it("splits the Engineer fixture into room context plus per-speaker user turns", async () => {
    const parsed = await parseGrokBotSession(join(fixtures, "group-eng.jsonl"));
    expect(parsed.title).toBe("Group: Vibe Replay launch");

    const userTurns = parsed.turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(3);
    expect(userTurns[0]).toMatchObject({
      subtype: "context-injection",
      blocks: [
        {
          type: "text",
          text: [
            "Group chat: Vibe Replay launch",
            "Participants: Vibe Replay Eng (engineer), Vibe Replay GTM (go-to-market)",
            "Mentions: @Vibe Replay Eng",
          ].join("\n"),
        },
      ],
    });
    expect(userTurns[1].subtype).toBeUndefined();
    expect(userTurns[1].blocks[0]).toEqual({
      type: "text",
      text: "**User:** Let's ship the Grok Bot replay provider this week.",
    });
    expect(userTurns[2].blocks[0]).toEqual({
      type: "text",
      text: "**Vibe Replay GTM:** @Vibe Replay Eng can you confirm the dashboard badge copy?",
    });
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("It's your turn"))).toBe(
      false,
    );

    const replay = transformToReplay(parsed, "grok-bot", "Vibe Replay launch");
    expect(replay.meta.title).toBe("Group: Vibe Replay launch");
    const types = replay.scenes.map((scene) => scene.type);
    expect(types[0]).toBe("context-injection");
    expect(replay.scenes[0]).toMatchObject({
      type: "context-injection",
      injectionType: "system",
    });
    const prompts = replay.scenes.filter((scene) => scene.type === "user-prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.type === "user-prompt" && prompts[0].content).toContain("**User:**");
    expect(prompts[1]?.type === "user-prompt" && prompts[1].content).toContain(
      "**Vibe Replay GTM:**",
    );
    expect(prompts[1]?.type === "user-prompt" && prompts[1].content).toContain("@Vibe Replay Eng");
  });

  it("parses the GTM fixture, keeps the User message, and skips empty wakes as prompts", async () => {
    const parsed = await parseGrokBotSession(join(fixtures, "group-gtm.jsonl"));
    expect(parsed.title).toBe("Group: Vibe Replay launch");

    const injections = parsed.turns.filter((turn) => turn.subtype === "context-injection");
    expect(injections).toHaveLength(2);
    expect(injections[1].blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No new messages since last turn."),
    });

    const speakerTurns = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(speakerTurns).toHaveLength(1);
    expect(speakerTurns[0].blocks[0]).toEqual({
      type: "text",
      text: "**User:** Let's ship the Grok Bot replay provider this week.",
    });
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("wrapping up"))).toBe(false);
  });
});
