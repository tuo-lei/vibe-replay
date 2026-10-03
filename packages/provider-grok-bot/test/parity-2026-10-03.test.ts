import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverGrokBotSessions } from "../src/grok-bot/discover.js";
import { parseGrokBotLines, parseGrokBotSession } from "../src/grok-bot/parser.js";
import { mergeReplicaTurns, replicaBlobFilename } from "../src/grok-bot/replica.js";
import { encodeBase32, decodeBase32 } from "../src/grok-bot/base32.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity");
const tempDirs: string[] = [];
const originalPersistence = process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR;

afterEach(async () => {
  if (originalPersistence === undefined) delete process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR;
  else process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR = originalPersistence;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf-8");
}

function texts(parsed: Awaited<ReturnType<typeof parseGrokBotLines>>): string[] {
  return parsed.turns.flatMap((turn) =>
    turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : "")),
  );
}

describe("2026-10-03 JSONL parity", () => {
  it("keeps a leading hidden-prompt remainder and splits concatenated wakes", async () => {
    const parsed = parseGrokBotLines(
      (await fixture("01-hidden-prefix-and-concat-wakes.jsonl")).split("\n"),
    );
    const body = texts(parsed).join("\n");
    expect(body).not.toContain("[SAND_HIDDEN_PROMPT]");
    expect(body).not.toContain("Earlier you prompted");
    expect(body).toContain("Background task completed");
    expect(body).toContain("Branch: demo/redacted");
    expect(body).toContain("Routine: Weekly review");
    expect(body).toContain("Please summarize the redacted note.");
    expect(body).toContain("status?");
    expect(parsed.title).toBe("Group: Example Room");
    expect(body).not.toContain("[object Object]");
    const background = texts(parsed).find((text) => text.startsWith("Background task completed"));
    expect(background).not.toContain("[Group chat:");
    expect(background).not.toContain("[routine]");
  });

  it("unwraps MCP content, marks isError, and keeps spill paths", async () => {
    const parsed = parseGrokBotLines(
      (await fixture("02-mcp-content-iserror-spill.jsonl")).split("\n"),
    );
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({
      name: "mcp__user-Github__pull_request_read",
      _result: "PR 1 title redacted. State: open.",
    });
    expect(tools[0]?.type === "tool_use" && tools[0]._isError).toBeFalsy();
    expect(tools[1]).toMatchObject({
      name: "mcp__user-search-console__indexing_publish",
      _isError: true,
      _result: "rate limited (redacted)",
    });
    expect(tools[2]?.type === "tool_use" && tools[2]._result).toContain("/tmp/redacted-spill.txt");
    expect(tools[2]?.type === "tool_use" && tools[2]._result).toContain("spilled");
    expect(tools[3]).toMatchObject({ name: "mcp", _isError: true, _result: "tool not found" });
  });

  it("treats shell spawnError as a failed tool card", async () => {
    const parsed = parseGrokBotLines(
      (await fixture("03-shell-spawn-failure-bookkeeping.jsonl")).split("\n"),
    );
    const tools = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(
      tools.map((block) => (block.type === "tool_use" ? block._isError === true : false)),
    ).toEqual([true, true, true]);
    expect(tools[0]).toMatchObject({ name: "Bash", _result: "sandbox failed to start" });
    expect(tools[1]).toMatchObject({ _result: "boom" });
    expect(tools[2]).toMatchObject({ _result: "approval denied" });
  });

  it("names computer-use verb keys and summarizes web search references", async () => {
    const computer = parseGrokBotLines(
      (await fixture("04-computer-use-action-keys.jsonl")).split("\n"),
    );
    const computerTool = computer.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(computerTool?.type === "tool_use" && computerTool.input.description).toBe(
      "click, wait, type, key, scroll",
    );
    const web = parseGrokBotLines((await fixture("05-web-search-references.jsonl")).split("\n"));
    const tools = web.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[0]).toMatchObject({ name: "WebSearch", _result: "Example result" });
    expect(tools[1]).toMatchObject({ name: "WebFetch", _isError: true, _result: "fetch failed" });
  });

  it("summarizes spilled reads and await states", async () => {
    const read = parseGrokBotLines((await fixture("06-read-blob-and-error.jsonl")).split("\n"));
    const reads = read.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(reads[0]?.type === "tool_use" && reads[0]._result).toContain("exceeded limit");
    expect(reads[0]?.type === "tool_use" && reads[0]._result).toContain("blob-redacted");
    expect(reads[2]).toMatchObject({ _isError: true, _result: "file not found" });
    const awaited = parseGrokBotLines((await fixture("07-await-task-subagent.jsonl")).split("\n"));
    const tools = awaited.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(tools[1]?.type === "tool_use" && tools[1]._result).toContain("still running");
    expect(tools[1]?.type === "tool_use" && tools[1]._result).toContain("/tmp/task-redacted.log");
    expect(tools[2]?.type === "tool_use" && tools[2]._result).toContain("complete");
  });

  it("unwraps communicate_update errors and keeps a failed empty send_message", async () => {
    const updates = parseGrokBotLines(
      (await fixture("08-communicate-update-error.jsonl")).split("\n"),
    );
    const cards = updates.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(cards[0]?.type === "tool_use" && cards[0].input.update).toBe("ran echo");
    expect(cards[1]?.type === "tool_use" && cards[1].input.update).toBe("command rejected");
    expect(JSON.stringify(cards[1])).not.toContain("__sand_tool__");

    const sent = parseGrokBotLines((await fixture("09-send-message-and-image.jsonl")).split("\n"));
    const reply = texts(sent).find((text) => text.includes("See the sketch"));
    expect(reply).toContain("cat.png");
    expect(reply).not.toContain("REDACTED");
    const failed = sent.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "send_message");
    expect(failed).toMatchObject({ _isError: true, _result: "empty message" });
  });
});

describe("Mac client replicas", () => {
  it("round-trips replica keys through base32", () => {
    const agentId = "33c0f7c3-3212-48eb-bd1b-1ce8c0ea0f88";
    const encoded = replicaBlobFilename(agentId, "0").replace(/\.blob$/, "");
    expect(decodeBase32(encoded)).toBe(
      `sand.client.slice.account.0.transcript.replicas.${agentId}`,
    );
    expect(decodeBase32(encodeBase32("hi"))).toBe("hi");
  });

  it("renders widget, cloud agent, attachment, connector, and voice entries", async () => {
    const types = JSON.parse(await fixture("message-type-samples.json")) as Record<string, unknown>;
    const kinds = JSON.parse(await fixture("kind-samples.json")) as Record<string, unknown>;
    const agentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const doc = {
      schemaVersion: 1,
      value: {
        entries: [
          kinds["user-message"],
          {
            kind: "send-message",
            id: "s-text",
            timestampMs: 1710000007000,
            seq: 8,
            message: types.text,
          },
          {
            kind: "send-message",
            id: "s-widget",
            timestampMs: 1710000008000,
            seq: 9,
            message: types.widget,
          },
          {
            kind: "send-message",
            id: "s-agent",
            timestampMs: 1710000009000,
            seq: 10,
            message: types["cursor-agent"],
          },
          {
            kind: "send-message",
            id: "s-file",
            timestampMs: 1710000010000,
            seq: 11,
            message: types.attachment,
          },
          {
            kind: "send-message",
            id: "s-conn",
            timestampMs: 1710000011000,
            seq: 12,
            message: types.connector,
          },
          {
            kind: "send-message",
            id: "s-review",
            timestampMs: 1710000012000,
            seq: 13,
            message: types["auto-review-approval"],
          },
          kinds["user-attachment"],
          kinds["voice-call"],
          kinds["event-name"],
          kinds.reaction,
        ],
      },
    };
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-replica-"));
    tempDirs.push(root);
    const persistence = join(root, "sand-client-persistence");
    await mkdir(persistence, { recursive: true });
    const blobName = replicaBlobFilename(agentId);
    await writeFile(join(persistence, blobName), JSON.stringify(doc));
    const transcripts = join(root, "agent-transcripts");
    await mkdir(transcripts, { recursive: true });
    process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR = persistence;

    const sessions = await discoverGrokBotSessions([transcripts], false);
    expect(sessions.map((session) => session.sessionId)).toEqual([agentId]);
    expect(sessions[0]?.prompts?.join("\n")).toContain("hello");
    expect(sessions[0]?.title).toBe("New");

    const parsed = await parseGrokBotSession(sessions[0]!.filePath);
    const body = texts(parsed).join("\n");
    expect(body).toContain("hello");
    expect(body).toContain("Synthetic reply. No secrets.");
    expect(body).toContain("Pick one");
    expect(body).toContain("Option A / Option B");
    expect(body).toContain("[cloud agent: Example cloud agent]");
    expect(body).not.toContain("bc-synthetic");
    expect(body).toContain("cat.png");
    expect(body).not.toContain("REDACTED");
    expect(body).toContain("[connector: example-graphql (connect)]");
    expect(body).toContain("[auto-review: Allow a redacted command");
    expect(body).toContain("shot.png");
    expect(body).toContain("Voice call hung-up (15s)");
    expect(body).toContain("Name changed from Old to New");
    expect(body).toContain("[reaction:");
  });

  it("merges replica UI turns onto JSONL without duplicating the same reply", async () => {
    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-merge-"));
    tempDirs.push(root);
    const transcripts = join(root, "agent-transcripts");
    const dir = join(transcripts, agentId);
    await mkdir(dir, { recursive: true });
    const jsonl = join(dir, `${agentId}.jsonl`);
    await writeFile(
      jsonl,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "send_message",
                input: { text: { content: "Synthetic reply. No secrets." } },
              },
            ],
          },
        }),
      ].join("\n"),
    );
    const persistence = join(root, "persistence");
    await mkdir(persistence, { recursive: true });
    const types = JSON.parse(await fixture("message-type-samples.json")) as Record<string, unknown>;
    const kinds = JSON.parse(await fixture("kind-samples.json")) as Record<string, unknown>;
    await writeFile(
      join(persistence, replicaBlobFilename(agentId)),
      JSON.stringify({
        schemaVersion: 1,
        value: {
          entries: [
            kinds["user-message"],
            { kind: "send-message", timestampMs: 1710000007000, seq: 1, message: types.text },
            { kind: "send-message", timestampMs: 1710000008000, seq: 2, message: types.widget },
          ],
        },
      }),
    );
    process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR = persistence;
    const sessions = await discoverGrokBotSessions([transcripts], false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.filePaths.some((path) => path.endsWith(".blob"))).toBe(true);
    const parsed = await parseGrokBotSession(sessions[0]!.filePaths);
    const replies = texts(parsed).filter((text) => text.includes("Synthetic reply"));
    expect(replies).toHaveLength(1);
    expect(texts(parsed).filter((text) => text === "hello")).toHaveLength(1);
    expect(texts(parsed).join("\n")).toContain("Pick one");
  });

  it("inserts an older replica turn before a later JSONL turn", () => {
    const merged = mergeReplicaTurns(
      [
        {
          role: "user",
          timestamp: "2026-10-03T12:00:00.000Z",
          blocks: [{ type: "text", text: "later prompt" }],
        },
      ],
      [
        {
          role: "user",
          subtype: "context-injection",
          timestamp: "2026-10-03T01:00:00.000Z",
          blocks: [{ type: "text", text: "Name changed to New" }],
        },
        {
          role: "user",
          timestamp: "2026-10-03T12:00:00.000Z",
          blocks: [{ type: "text", text: "later prompt" }],
        },
      ],
    );
    expect(
      merged.map((turn) => (turn.blocks[0]?.type === "text" ? turn.blocks[0].text : "")),
    ).toEqual(["Name changed to New", "later prompt"]);
  });

  it("keeps a repeated replica message that JSONL only has once", () => {
    const merged = mergeReplicaTurns(
      [
        {
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
        },
      ],
      [
        {
          role: "user",
          timestamp: "2026-10-03T01:00:00.000Z",
          blocks: [{ type: "text", text: "continue" }],
        },
        {
          role: "user",
          timestamp: "2026-10-03T02:00:00.000Z",
          blocks: [{ type: "text", text: "continue" }],
        },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.timestamp).toBe("2026-10-03T02:00:00.000Z");
  });

  it("prefers the newer of tool timestamp and file mtime", async () => {
    const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-mtime-"));
    tempDirs.push(root);
    const dir = join(root, agentId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${agentId}.jsonl`);
    await writeFile(
      path,
      [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "still here" }] },
        }),
        JSON.stringify({
          role: "tool",
          message: {
            content: [
              {
                type: "tool_result",
                name: "shell",
                result: { success: { timestamp: "2026-09-10T20:54:49.941Z", stdout: "ok" } },
              },
            ],
          },
        }),
      ].join("\n"),
    );
    const mtime = new Date("2026-10-03T07:42:00.000Z");
    await utimes(path, mtime, mtime);
    const sessions = await discoverGrokBotSessions([root], false);
    expect(sessions[0]?.timestamp).toBe(mtime.toISOString());
  });

  it("resolves profile title and cwd when parse is given only a jsonl path", async () => {
    const agentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-profile-"));
    tempDirs.push(root);
    const transcripts = join(root, "agent-transcripts");
    const dir = join(transcripts, agentId);
    await mkdir(join(root, "agents", agentId), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(root, "agents", agentId, "profile.json"),
      JSON.stringify({ name: "Site Eng", cwd: "/workspace/site" }),
    );
    const jsonl = join(dir, `${agentId}.jsonl`);
    await writeFile(
      jsonl,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "ship the page" }] },
      })}\n`,
    );
    const parsed = await parseGrokBotSession(jsonl);
    expect(parsed.title).toBe("Site Eng");
    expect(parsed.cwd).toBe("/workspace/site");
  });
});
