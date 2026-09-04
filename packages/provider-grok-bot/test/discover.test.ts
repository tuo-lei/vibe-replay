import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGrokBotTranscriptRoots } from "../src/grok-bot/config.js";
import { discoverGrokBotSessions } from "../src/grok-bot/discover.js";

const originalTranscriptsDir = process.env.GROK_BOT_TRANSCRIPTS_DIR;
const originalVibeDir = process.env.VIBE_REPLAY_GROK_BOT_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalTranscriptsDir === undefined) delete process.env.GROK_BOT_TRANSCRIPTS_DIR;
  else process.env.GROK_BOT_TRANSCRIPTS_DIR = originalTranscriptsDir;
  if (originalVibeDir === undefined) delete process.env.VIBE_REPLAY_GROK_BOT_DIR;
  else process.env.VIBE_REPLAY_GROK_BOT_DIR = originalVibeDir;
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const sampleLines = [
  {
    role: "user",
    message: { content: [{ type: "text", text: "[SAND_HIDDEN_PROMPT][first run] ..." }] },
  },
  {
    role: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "send_message",
          input: { text: { content: "Hey — good to meet you." } },
        },
      ],
    },
  },
  {
    role: "tool",
    message: {
      content: [
        {
          type: "tool_result",
          name: "send_message",
          result: { success: { timestamp: "1788485400095", messageId: "tbs0" } },
        },
      ],
    },
  },
  {
    role: "user",
    message: { content: [{ type: "text", text: "[t0u]\n你给我介绍grok bot" }] },
  },
  {
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "private scratch reasoning" },
        { type: "tool_use", name: "send_message", input: { text: { content: "先给你讲清楚…" } } },
      ],
    },
  },
  {
    role: "tool",
    message: {
      content: [
        { type: "tool_result", name: "send_message", result: { success: { messageId: "t0s0" } } },
      ],
    },
  },
  {
    role: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "read", input: { path: "/home/box/reference/app-ui.md" } },
      ],
    },
  },
  {
    role: "tool",
    message: {
      content: [
        {
          type: "tool_result",
          name: "read",
          result: { success: { content: "# The Grok Bot app UI…" } },
        },
      ],
    },
  },
];

async function writeSession(root: string, agentId: string, lines: unknown[] = sampleLines) {
  const dir = join(root, agentId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${agentId}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return path;
}

describe("getGrokBotTranscriptRoots", () => {
  it("prefers GROK_BOT_TRANSCRIPTS_DIR over VIBE_REPLAY_GROK_BOT_DIR", () => {
    process.env.GROK_BOT_TRANSCRIPTS_DIR = "/tmp/grok-primary";
    process.env.VIBE_REPLAY_GROK_BOT_DIR = "/tmp/grok-secondary";
    expect(getGrokBotTranscriptRoots()).toEqual(["/tmp/grok-primary"]);
  });

  it("falls back to VIBE_REPLAY_GROK_BOT_DIR when the primary env is unset", () => {
    delete process.env.GROK_BOT_TRANSCRIPTS_DIR;
    process.env.VIBE_REPLAY_GROK_BOT_DIR = "/tmp/grok-secondary";
    expect(getGrokBotTranscriptRoots()).toEqual(["/tmp/grok-secondary"]);
  });

  it("includes the cloud-box defaults and export path when no env is set", () => {
    delete process.env.GROK_BOT_TRANSCRIPTS_DIR;
    delete process.env.VIBE_REPLAY_GROK_BOT_DIR;
    const roots = getGrokBotTranscriptRoots();
    expect(roots).toContain("/home/box/agent-data/agent-transcripts");
    expect(roots).toContain("/home/box/sand-data/agent-transcripts");
    expect(roots.some((root) => root.endsWith("/.grok-bot/agent-transcripts"))).toBe(true);
  });
});

describe("discoverGrokBotSessions", () => {
  it("discovers <id>/<id>.jsonl sessions, skips hidden prompts, and reads profile names", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vibe-grok-bot-discover-"));
    tempDirs.push(dataRoot);
    const transcripts = join(dataRoot, "agent-transcripts");
    const agentId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    await writeSession(transcripts, agentId);
    await mkdir(join(dataRoot, "agents", agentId), { recursive: true });
    await writeFile(
      join(dataRoot, "agents", agentId, "profile.json"),
      JSON.stringify({ name: "demo-project", cwd: "/home/box/demo-project" }),
      "utf-8",
    );
    process.env.GROK_BOT_TRANSCRIPTS_DIR = transcripts;

    const sessions = await discoverGrokBotSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "grok-bot",
      sessionId: agentId,
      title: "demo-project",
      cwd: "/home/box/demo-project",
      project: "/home/box/demo-project",
      promptCount: 1,
      toolCallCount: 1,
      firstPrompt: "你给我介绍grok bot",
    });
    expect(sessions[0].timestamp).toBe(new Date(1788485400095).toISOString());
  });

  it("indexes sand-subagent transcripts as separate sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-bot-subagent-"));
    tempDirs.push(root);
    const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const subId = "sand-subagent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await writeSession(root, parentId);
    await writeSession(root, subId, [
      {
        role: "user",
        message: { content: [{ type: "text", text: "explore the UI spec" }] },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "read", input: { path: "/home/box/reference/app-ui.md" } },
          ],
        },
      },
    ]);

    const sessions = await discoverGrokBotSessions([root], false);
    expect(sessions.map((session) => session.sessionId).sort()).toEqual([parentId, subId].sort());
    const sub = sessions.find((session) => session.sessionId === subId);
    expect(sub).toMatchObject({
      title: "Grok Bot subagent",
      firstPrompt: "explore the UI spec",
    });
  });

  it("dedupes symlink-overlapping roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-bot-symlink-"));
    tempDirs.push(root);
    const sand = join(root, "sand-data", "agent-transcripts");
    const agentData = join(root, "agent-data");
    await mkdir(sand, { recursive: true });
    await symlink(join(root, "sand-data"), agentData);
    await writeSession(sand, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    const sessions = await discoverGrokBotSessions(
      [join(agentData, "agent-transcripts"), sand],
      false,
    );
    expect(sessions).toHaveLength(1);
  });

  it("can retain a readable transcript with no prompts for status display", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-bot-no-prompts-"));
    tempDirs.push(root);
    await writeSession(root, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", [
      {
        role: "user",
        message: { content: [{ type: "text", text: "[SAND_HIDDEN_PROMPT] bootstrap" }] },
      },
    ]);

    const sessions = await discoverGrokBotSessions([root], false, true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      transcriptStatus: "no-prompts",
      firstPrompt: "",
      promptCount: 0,
    });
  });

  it("uses file mtime for unreadable transcript fallback timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-bot-unreadable-"));
    tempDirs.push(root);
    const agentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const dir = join(root, agentId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${agentId}.jsonl`);
    const mtime = new Date("2026-01-02T03:04:05.000Z");
    await writeFile(path, "{not-json}\n", "utf-8");
    await utimes(path, mtime, mtime);

    const sessions = await discoverGrokBotSessions([root], false, true);
    expect(sessions[0]).toMatchObject({
      sessionId: agentId,
      timestamp: mtime.toISOString(),
      transcriptStatus: "unreadable",
    });
  });

  it("labels group-chat sessions from the wake payload and sibling group.json", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vibe-grok-bot-group-"));
    tempDirs.push(dataRoot);
    const transcripts = join(dataRoot, "agent-transcripts");
    const engId = "11111111-1111-4111-8111-111111111111";
    await writeSession(transcripts, engId, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `[t0u]\n[Group chat: "Vibe Replay launch" - with Vibe Replay GTM]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
New messages in the room (oldest first):
User: Let's ship the Grok Bot replay provider this week.
Vibe Replay GTM: @Vibe Replay Eng can you confirm the dashboard badge copy?

It's your turn, Vibe Replay Eng. Reply in the room.`,
            },
          ],
        },
      },
    ]);
    await mkdir(join(dataRoot, "agents", engId), { recursive: true });
    await writeFile(
      join(dataRoot, "agents", engId, "profile.json"),
      JSON.stringify({ name: "Vibe Replay Eng" }),
      "utf-8",
    );
    await writeFile(
      join(dataRoot, "agents", engId, "group.json"),
      JSON.stringify({
        title: "folder-title-should-lose-to-transcript",
        participants: ["Vibe Replay Eng", "Vibe Replay GTM"],
      }),
      "utf-8",
    );
    process.env.GROK_BOT_TRANSCRIPTS_DIR = transcripts;

    const sessions = await discoverGrokBotSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      title: "Group: Vibe Replay launch",
      project: "Vibe Replay launch",
      cwd: "Vibe Replay Eng",
      promptCount: 2,
      firstPrompt: "**User:** Let's ship the Grok Bot replay provider this week.",
    });
    expect(sessions[0].firstPrompt).not.toContain("It's your turn");
    expect(sessions[0].firstPrompt).not.toContain("[Group chat:");
  });

  it("uses group.json / profile groupTitle when the transcript has not named the room yet", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vibe-grok-bot-group-profile-"));
    tempDirs.push(dataRoot);
    const transcripts = join(dataRoot, "agent-transcripts");
    const gtmId = "22222222-2222-4222-8222-222222222222";
    await writeSession(transcripts, gtmId, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "draft the launch note",
            },
          ],
        },
      },
    ]);
    await mkdir(join(dataRoot, "agents", gtmId), { recursive: true });
    await writeFile(
      join(dataRoot, "agents", gtmId, "profile.json"),
      JSON.stringify({ name: "Vibe Replay GTM", groupTitle: "Vibe Replay launch" }),
      "utf-8",
    );
    process.env.GROK_BOT_TRANSCRIPTS_DIR = transcripts;

    const sessions = await discoverGrokBotSessions();
    expect(sessions[0]).toMatchObject({
      title: "Group: Vibe Replay launch",
      project: "Vibe Replay launch",
      firstPrompt: "draft the launch note",
      promptCount: 1,
    });
  });

  it("does not count a no-new-messages group wake as a user prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-bot-group-empty-"));
    tempDirs.push(root);
    await writeSession(root, "33333333-3333-4333-8333-333333333333", [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `[Group chat: "Vibe Replay launch" - with Vibe Replay Eng]
Participants: Vibe Replay Eng (engineer) Vibe Replay GTM (go-to-market)
No new messages in the room since your last turn.
It's your turn, Vibe Replay GTM.`,
            },
          ],
        },
      },
    ]);

    const hidden = await discoverGrokBotSessions([root], false);
    expect(hidden).toHaveLength(0);

    const visible = await discoverGrokBotSessions([root], false, true);
    expect(visible[0]).toMatchObject({
      title: "Group: Vibe Replay launch",
      project: "Vibe Replay launch",
      transcriptStatus: "no-prompts",
      promptCount: 0,
      firstPrompt: "",
    });
  });
});
