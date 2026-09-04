import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractGroupMentions,
  formatGroupHeader,
  formatGroupSpeakerMessage,
  isGrokBotGroupChatPayload,
  isHumanGroupSpeaker,
  parseGrokBotGroupWake,
  parseGrokBotLines,
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

  it("drops waiting-for-participants cues and peels a routine tag before the group header", () => {
    const wake = parseGrokBotGroupWake(`[Group chat: "Launch room" - with Vibe Replay GTM]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: ping
Waiting for other participants.
It's your turn, Vibe Replay Eng.`);
    expect(wake?.messages).toEqual([{ speaker: "User", text: "ping", mentions: [] }]);
    expect(wake?.messages.some((msg) => /waiting for/i.test(msg.text))).toBe(false);
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

  it("treats listed participants as bots and everyone else as human", () => {
    const bots = ["Vibe Replay Eng", "Vibe Replay GTM"];
    expect(isHumanGroupSpeaker("User", bots)).toBe(true);
    expect(isHumanGroupSpeaker("Tuo", bots)).toBe(true);
    expect(isHumanGroupSpeaker("Vibe Replay GTM", bots)).toBe(false);
    expect(isHumanGroupSpeaker("vibe replay eng", bots)).toBe(false);
  });
});

describe("Grok Bot group-chat session parse", () => {
  it("peels a [routine] tag so a wrapped group wake still splits by speaker", () => {
    const parsed = parseGrokBotLines([
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `[routine]
[Group chat: "Vibe Replay launch" - with Vibe Replay GTM]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: Let's ship it.
It's your turn, Vibe Replay Eng.`,
            },
          ],
        },
      }),
    ]);
    expect(parsed.title).toBe("Group: Vibe Replay launch");
    const users = parsed.turns.filter((turn) => turn.role === "user");
    expect(users[0]).toMatchObject({ subtype: "context-injection" });
    expect(users[1]).toMatchObject({
      role: "user",
      speaker: "User",
      blocks: [{ type: "text", text: "Let's ship it." }],
    });
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("[routine]"))).toBe(false);
  });

  it("splits the Engineer fixture into room context, a human user, and assistant-side GTM", async () => {
    const parsed = await parseGrokBotSession(join(fixtures, "group-eng.jsonl"));
    expect(parsed.title).toBe("Group: Vibe Replay launch");

    const injections = parsed.turns.filter((turn) => turn.subtype === "context-injection");
    expect(injections).toHaveLength(1);
    expect(injections[0].blocks[0]).toEqual({
      type: "text",
      text: [
        "Group chat: Vibe Replay launch",
        "Participants: Vibe Replay Eng (engineer), Vibe Replay GTM (go-to-market)",
        "Mentions: @Vibe Replay Eng",
      ].join("\n"),
    });

    const humans = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({
      speaker: "User",
      blocks: [{ type: "text", text: "Let's ship the Grok Bot replay provider this week." }],
    });

    const gtm = parsed.turns.find((turn) => turn.speaker === "Vibe Replay GTM");
    expect(gtm).toMatchObject({
      role: "assistant",
      blocks: [
        {
          type: "text",
          text: "@Vibe Replay Eng can you confirm the dashboard badge copy?",
        },
      ],
    });

    const eng = parsed.turns.find(
      (turn) => turn.role === "assistant" && turn.speaker === "Vibe Replay Eng",
    );
    expect(eng?.blocks[0]).toEqual({ type: "thinking", thinking: "checking badge copy" });
    expect(eng?.blocks[1]).toEqual({
      type: "text",
      text: "Badge copy looks good — I'll confirm on the Eng side.",
    });
    expect(eng?.blocks[2]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("It's your turn"))).toBe(
      false,
    );

    const replay = transformToReplay(parsed, "grok-bot", "Vibe Replay launch");
    expect(replay.meta.title).toBe("Group: Vibe Replay launch");
    expect(replay.scenes[0]).toMatchObject({
      type: "context-injection",
      injectionType: "system",
    });
    const prompts = replay.scenes.filter((scene) => scene.type === "user-prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      content: "Let's ship the Grok Bot replay provider this week.",
      speaker: "User",
    });
    const gtmScene = replay.scenes.find(
      (scene) => scene.type === "text-response" && scene.speaker === "Vibe Replay GTM",
    );
    expect(gtmScene).toMatchObject({
      type: "text-response",
      content: "@Vibe Replay Eng can you confirm the dashboard badge copy?",
    });
    const engReply = replay.scenes.find(
      (scene) => scene.type === "text-response" && scene.speaker === "Vibe Replay Eng",
    );
    expect(engReply).toMatchObject({
      content: "Badge copy looks good — I'll confirm on the Eng side.",
    });
    expect(
      replay.scenes.some(
        (scene) => scene.type === "thinking" && scene.content === "checking badge copy",
      ),
    ).toBe(true);
  });

  it("parses the GTM fixture, keeps the User message, and skips empty wakes as prompts", async () => {
    const parsed = await parseGrokBotSession(join(fixtures, "group-gtm.jsonl"));
    expect(parsed.title).toBe("Group: Vibe Replay launch");

    const injections = parsed.turns.filter((turn) => turn.subtype === "context-injection");
    // Repeat wakes for the same room used to re-emit the header (including the
    // empty "no new messages" wake). That duplicated the System Context card.
    expect(injections).toHaveLength(1);
    expect(injections[0].blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Group chat: Vibe Replay launch"),
    });

    const speakerTurns = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(speakerTurns).toHaveLength(1);
    expect(speakerTurns[0]).toMatchObject({
      speaker: "User",
      blocks: [{ type: "text", text: "Let's ship the Grok Bot replay provider this week." }],
    });
    const gtm = parsed.turns.find((turn) => turn.role === "assistant");
    expect(gtm?.blocks[0]).toEqual({
      type: "thinking",
      thinking: "drafting launch note internally",
    });
    expect(gtm?.blocks[1]).toEqual({
      type: "text",
      text: "On it — I'll draft the launch note.",
    });
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("wrapping up"))).toBe(false);
    expect(parsed.turns.some((turn) => JSON.stringify(turn).includes("No new messages"))).toBe(
      false,
    );
  });

  it("merges Eng+GTM transcripts onto one timeline and drops injected peer text", async () => {
    const parsed = await parseGrokBotSession([
      join(fixtures, "group-eng.jsonl"),
      join(fixtures, "group-gtm.jsonl"),
    ]);
    expect(parsed.title).toBe("Group: Vibe Replay launch");
    expect(parsed.diagnosticNotes?.some((note) => /merged group room/i.test(note))).toBe(true);

    const humans = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(humans).toHaveLength(1);
    expect(humans[0].blocks[0]).toEqual({
      type: "text",
      text: "Let's ship the Grok Bot replay provider this week.",
    });

    const injectedParaphrase = parsed.turns.some(
      (turn) =>
        JSON.stringify(turn).includes("can you confirm the dashboard badge copy") &&
        turn.role === "assistant",
    );
    expect(injectedParaphrase).toBe(false);

    const gtmReplies = parsed.turns.filter((turn) => turn.speaker === "Vibe Replay GTM");
    expect(gtmReplies).toHaveLength(1);
    expect(gtmReplies[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "drafting launch note internally" },
        { type: "text", text: "On it — I'll draft the launch note." },
      ],
    });

    const eng = parsed.turns.find((turn) => turn.speaker === "Vibe Replay Eng");
    expect(eng).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "checking badge copy" },
        { type: "text", text: "Badge copy looks good — I'll confirm on the Eng side." },
        { type: "tool_use", name: "Read" },
      ],
    });

    const replay = transformToReplay(parsed, "grok-bot", "Vibe Replay launch");
    const speakers = replay.scenes
      .map((scene) => ("speaker" in scene ? scene.speaker : undefined))
      .filter(Boolean);
    expect(speakers).toContain("User");
    expect(speakers).toContain("Vibe Replay Eng");
    expect(speakers).toContain("Vibe Replay GTM");
    expect(replay.scenes.filter((scene) => scene.type === "user-prompt")).toHaveLength(1);
    expect(
      replay.scenes.some(
        (scene) =>
          scene.type === "text-response" &&
          scene.content.includes("On it — I'll draft the launch note."),
      ),
    ).toBe(true);
    expect(
      replay.scenes.some((scene) =>
        JSON.stringify(scene).includes("can you confirm the dashboard badge copy"),
      ),
    ).toBe(false);
  });
});
