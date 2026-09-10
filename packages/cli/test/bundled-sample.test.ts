import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaudeCodeSession } from "@vibe-replay/provider-claude-code/claude-code/parser";
import { discoverGrokBotSessions } from "@vibe-replay/provider-grok-bot/discover";
import { parseGrokBotSession } from "@vibe-replay/provider-grok-bot/parser";
import {
  BUNDLED_GROK_BOT_SAMPLE_SESSION_ID,
  BUNDLED_SAMPLE_SESSION_ID,
  isBundledSampleSession,
  loadBundledGrokBotSampleSession,
  loadBundledSampleSession,
  resolveBundledGrokBotSamplePath,
  resolveBundledSamplePath,
  withBundledSampleIfEmpty,
} from "../src/bundled-sample.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

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

function session(sessionId: string, provider = "cursor"): SessionInfo {
  return {
    provider,
    sessionId,
    slug: sessionId.slice(0, 8),
    project: "/repo",
    cwd: "/repo",
    version: "",
    timestamp: "2026-08-20T10:00:00.000Z",
    lineCount: 1,
    fileSize: 1,
    filePath: `/${sessionId}.jsonl`,
    filePaths: [`/${sessionId}.jsonl`],
    firstPrompt: "prompt",
  };
}

describe("bundled sample session", () => {
  it("resolves the packaged welcome fixture", async () => {
    const path = await resolveBundledSamplePath();
    expect(path?.replaceAll("\\", "/")).toMatch(/assets\/samples\/welcome\.jsonl$/);
    const sample = await loadBundledSampleSession();
    expect(sample?.sessionId).toBe(BUNDLED_SAMPLE_SESSION_ID);
    expect(sample?.title).toBe("Sample: Welcome to vibe-replay");
    expect(sample?.provider).toBe("claude-code");
    expect(sample?.promptCount).toBe(1);
    expect(isBundledSampleSession(sample!)).toBe(true);
  });

  it("fills an empty discovery list with Claude and Grok Bot samples", async () => {
    const empty = await withBundledSampleIfEmpty([]);
    expect(empty.map((item) => item.sessionId)).toEqual([
      BUNDLED_SAMPLE_SESSION_ID,
      BUNDLED_GROK_BOT_SAMPLE_SESSION_ID,
    ]);
    expect(empty[0].provider).toBe("claude-code");
    expect(empty[1].provider).toBe("grok-bot");
  });

  it("leaves real grok-bot sessions alone and does not duplicate the sample", async () => {
    const realGrok = [session("real-grok", "grok-bot")];
    expect(await withBundledSampleIfEmpty(realGrok)).toEqual(realGrok);
  });

  it("appends the Grok Bot sample when other providers have sessions but grok roots are empty", async () => {
    const real = [session("real-session")];
    const mixed = await withBundledSampleIfEmpty(real);
    expect(mixed).toHaveLength(2);
    expect(mixed[0]).toEqual(real[0]);
    expect(mixed[1].sessionId).toBe(BUNDLED_GROK_BOT_SAMPLE_SESSION_ID);
    expect(mixed[1].provider).toBe("grok-bot");
  });

  it("parses through the Claude Code provider", async () => {
    const path = await resolveBundledSamplePath();
    expect(path).toBeTruthy();
    const parsed = await parseClaudeCodeSession(path!);
    expect(parsed.sessionId).toBe(BUNDLED_SAMPLE_SESSION_ID);
    expect(parsed.turns.some((turn) => turn.role === "user")).toBe(true);
    expect(parsed.turns.some((turn) => turn.role === "assistant")).toBe(true);
    const text = await readFile(path!, "utf-8");
    expect(text).toContain("bundled sample session");
  });
});

describe("bundled Grok Bot sample", () => {
  it("resolves the packaged grok-bot fixture", async () => {
    const path = await resolveBundledGrokBotSamplePath();
    expect(path?.replaceAll("\\", "/")).toMatch(/assets\/samples\/grok-bot\.jsonl$/);
    const sample = await loadBundledGrokBotSampleSession();
    expect(sample?.sessionId).toBe(BUNDLED_GROK_BOT_SAMPLE_SESSION_ID);
    expect(sample?.title).toBe("Sample: Grok Bot Eng+GTM");
    expect(sample?.provider).toBe("grok-bot");
    expect(sample?.promptCount).toBe(1);
    expect(sample?.toolCallCount).toBe(2);
    expect(sample?.firstPrompt).toBe("Show me what a Grok Bot replay looks like.");
    expect(sample?.timestamp).toBe("2026-09-01T12:00:10.000Z");
    expect(isBundledSampleSession(sample!)).toBe(true);
    const text = await readFile(path!, "utf-8");
    expect(text).not.toMatch(/data:image\/[^;]+;base64,/);
    expect(text.length).toBeLessThan(4_000);
    expect(text).toContain('"timestamp":"1788264010000"');
    expect(text).toContain('"timestamp":"1788264014000"');
    expect(new Date(1_788_264_010_000).toISOString()).toBe("2026-09-01T12:00:10.000Z");
  });

  it("discovers the grok sample when transcript roots are empty", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "vibe-replay-grok-bot-empty-"));
    tempDirs.push(emptyRoot);
    process.env.GROK_BOT_TRANSCRIPTS_DIR = emptyRoot;
    delete process.env.VIBE_REPLAY_GROK_BOT_DIR;

    const discovered = await discoverGrokBotSessions();
    expect(discovered).toHaveLength(0);

    const withSample = await withBundledSampleIfEmpty(discovered);
    const grok = withSample.find((item) => item.provider === "grok-bot");
    expect(grok?.sessionId).toBe(BUNDLED_GROK_BOT_SAMPLE_SESSION_ID);
    expect(grok?.filePath.replaceAll("\\", "/")).toMatch(/assets\/samples\/grok-bot\.jsonl$/);
  });

  it("parses through the Grok Bot provider as a short multi-speaker session", async () => {
    const path = await resolveBundledGrokBotSamplePath();
    expect(path).toBeTruthy();
    const sample = await loadBundledGrokBotSampleSession();
    const parsed = await parseGrokBotSession(path!, sample ?? undefined);
    expect(parsed.sessionId).toBe(BUNDLED_GROK_BOT_SAMPLE_SESSION_ID);
    expect(parsed.title).toBe("Group: Vibe Replay sample");

    const humans = parsed.turns.filter((turn) => turn.role === "user" && !turn.subtype);
    expect(humans).toHaveLength(1);
    expect(humans[0].blocks).toEqual([
      { type: "text", text: "Show me what a Grok Bot replay looks like." },
    ]);

    const gtm = parsed.turns.find((turn) => turn.speaker === "Vibe Replay GTM");
    expect(gtm).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "@Vibe Replay Eng walk through a tiny session." }],
    });

    const ownerReply = parsed.turns.find(
      (turn) =>
        turn.role === "assistant" &&
        turn.blocks.some(
          (block) => block.type === "text" && block.text.includes("bundled Grok Bot sample"),
        ),
    );
    expect(ownerReply).toBeTruthy();
    expect(
      parsed.turns.some(
        (turn) =>
          turn.role === "assistant" &&
          turn.blocks.some((block) => block.type === "tool_use" && block.name === "Read"),
      ),
    ).toBe(true);
  });
});
