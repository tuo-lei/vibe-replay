import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGrokBotSessions } from "../src/grok-bot/discover.js";
import {
  countGrokBotDiscoveryStats,
  parseGrokBotLines,
  parseGrokBotSession,
} from "../src/grok-bot/parser.js";
import { mergeReplicaTurns, replicaBlobFilename } from "../src/grok-bot/replica.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const originalPersistence = process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR;
let root: string;
let transcripts: string;
let persistence: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "grok-replica-review-"));
  transcripts = join(root, "agent-transcripts");
  persistence = join(root, "persistence");
  await mkdir(join(transcripts, agentId), { recursive: true });
  await mkdir(persistence);
  process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR = persistence;
});

afterEach(async () => {
  if (originalPersistence === undefined) delete process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR;
  else process.env.GROK_BOT_CLIENT_PERSISTENCE_DIR = originalPersistence;
  await rm(root, { recursive: true, force: true });
});

function prompt(text: string, timestamp: string) {
  return { timestamp, role: "user", message: { content: [{ type: "text", text }] } };
}

async function writeSources(records: unknown[], entries: unknown[]) {
  await writeFile(
    join(transcripts, agentId, `${agentId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await writeFile(
    join(persistence, replicaBlobFilename(agentId)),
    JSON.stringify({ value: { entries } }),
  );
}

function body(parsed: ReturnType<typeof parseGrokBotLines>) {
  return parsed.turns.flatMap((turn) =>
    turn.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  );
}

describe("JSONL and Mac replica review regressions", () => {
  it("attaches an assistant-only replica window to a playable JSONL", async () => {
    await writeSources(
      [prompt("hello", "2026-10-03T01:00:00.000Z")],
      [
        {
          kind: "send-message",
          timestampMs: Date.parse("2026-10-03T01:00:01.000Z"),
          message: { text: { content: "visible reply" } },
        },
        {
          kind: "voice-call",
          timestampMs: Date.parse("2026-10-03T01:00:02.000Z"),
          call: { ending: "hung-up", durationMs: 1000 },
        },
        {
          kind: "event",
          timestampMs: Date.parse("2026-10-03T01:00:03.000Z"),
          event: { type: "name-changed", to: "Helper" },
        },
      ],
    );
    const sessions = await discoverGrokBotSessions([transcripts], false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.filePaths).toHaveLength(2);
    const parsed = await parseGrokBotSession(sessions[0]!.filePaths);
    expect(body(parsed)).toEqual([
      "hello",
      "visible reply",
      "Voice call hung-up (1s)",
      "Name changed to Helper",
    ]);
    await rm(join(transcripts, agentId), { recursive: true });
    expect(await discoverGrokBotSessions([transcripts], false)).toHaveLength(0);
  });

  it("consumes one cross-source reply despite clock skew and retains a repeated reply", () => {
    const turn = (timestamp: string) => ({
      role: "assistant" as const,
      timestamp,
      blocks: [{ type: "text" as const, text: "done" }],
    });
    const merged = mergeReplicaTurns(
      [turn("2026-10-03T01:00:00.000Z")],
      [turn("2026-10-03T01:00:01.000Z"), turn("2026-10-03T02:00:00.000Z")],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((turn) => turn.timestamp)).toEqual([
      "2026-10-03T01:00:00.000Z",
      "2026-10-03T02:00:00.000Z",
    ]);
  });

  it("matches discovery prompt counts and previews to the merged replay timeline", async () => {
    await writeSources(
      [prompt("continue", "2026-10-03T02:00:00.000Z")],
      [
        {
          kind: "message",
          content: "earlier UI prompt",
          timestampMs: Date.parse("2026-10-03T01:00:00.000Z"),
        },
        {
          kind: "message",
          content: "continue",
          timestampMs: Date.parse("2026-10-03T02:00:01.000Z"),
        },
        {
          kind: "message",
          content: "continue",
          timestampMs: Date.parse("2026-10-03T03:00:00.000Z"),
        },
        {
          kind: "user-attachment",
          file_name: "sketch.png",
          timestampMs: Date.parse("2026-10-03T04:00:00.000Z"),
        },
      ],
    );
    const sessions = await discoverGrokBotSessions([transcripts], false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      promptCount: 4,
      firstPrompt: "earlier UI prompt",
      prompts: ["earlier UI prompt", "continue"],
    });
    const parsed = await parseGrokBotSession(sessions[0]!.filePaths);
    expect(body(parsed)).toEqual([
      "earlier UI prompt",
      "continue",
      "continue",
      "[attached image: sketch.png]",
    ]);
    expect(parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype)).toHaveLength(
      sessions[0]!.promptCount!,
    );
  });

  it("keeps incomplete answering-question prose as one multiline prompt", () => {
    const text = "Intro\n[Answering your question generally] here is an explanation.";
    const record = JSON.stringify(prompt(text, "2026-10-03T01:00:00.000Z"));
    expect(body(parseGrokBotLines([record]))).toEqual([text]);
    expect(countGrokBotDiscoveryStats(record).promptCount).toBe(1);
    const wrapped = JSON.stringify(
      prompt('Intro\n[Answering your question tbs1: "Why?"] because', "2026-10-03T01:00:00.000Z"),
    );
    expect(body(parseGrokBotLines([wrapped]))).toEqual([
      "Intro",
      "Answering previous question tbs1: Why?",
      "because",
    ]);
  });
});
