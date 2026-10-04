import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each([
  ["session.cursor-export/copy.jsonl", false],
  ["copy.cursor.jsonl", false],
  [".grok-bot/agent-transcripts/chat/chat.jsonl", true],
  ["agent-data/agent-transcripts/chat/chat.jsonl", true],
  ["sand-data/agent-transcripts/chat/chat.jsonl", true],
])("uses provider directory boundaries for %s (oversized: %s)", async (relative, oversized) => {
  const root = await mkdtemp(join(tmpdir(), "vibe-path-boundaries-"));
  try {
    const source = join(root, relative);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(
      source,
      [
        {
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: oversized
                  ? `[SAND_HIDDEN_PROMPT]${"x".repeat(1_200_000)}`
                  : "[routine]\nReview the deploy",
              },
            ],
          },
        },
        { role: "user", message: { content: [{ type: "text", text: "Actual task" }] } },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "Private scratch" },
              {
                type: "tool_use",
                name: "send_message",
                toolCallId: "reply",
                input: { text: { content: "Visible reply" } },
              },
            ],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const before = await readFile(source),
      { stdout } = await exec(
        process.execPath,
        [cli, "export", source, "--format", "json", "--stdout"],
        {
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            VIBE_REPLAY_CONFIG: join(root, "missing.json"),
            VIBE_REPLAY_TELEMETRY: "0",
          },
        },
      ),
      replay = JSON.parse(stdout);
    expect(replay.meta.provider).toBe("grok-bot");
    expect(replay.meta.stats.userPrompts).toBe(1);
    expect(replay.scenes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "user-prompt", content: "Actual task" }),
        expect.objectContaining({ type: "thinking", content: "Private scratch" }),
        expect.objectContaining({ type: "text-response", content: "Visible reply" }),
      ]),
    );
    expect(stdout).not.toContain("[SAND_HIDDEN_PROMPT]");
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
