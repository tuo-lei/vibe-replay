import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each([
  ["copied", "[agent]"],
  ["copied", "[event]"],
  ["copied", "[first run]"],
  ["native", "[agent]"],
  ["native", "[event]"],
  ["native", "[first run]"],
])("preserves %s Cursor %s with a nested custom messaging payload", async (kind, tag) => {
  const root = await mkdtemp(join(tmpdir(), "vibe-cursor-combined-"));
  try {
    const source =
        kind === "native"
          ? join(root, ".cursor/projects/demo/agent-transcripts/chat.jsonl")
          : join(root, "copy.jsonl"),
      prompt = `${tag}\nImplement the event handler`,
      reply = "Normal Cursor assistant text";
    await mkdir(dirname(source), { recursive: true });
    await writeFile(
      source,
      [
        { role: "user", message: { content: [{ type: "text", text: prompt }] } },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: reply },
              {
                type: "tool_use",
                id: "cursor-call-1",
                name: "send_message",
                input: { text: { content: "Custom tool message" } },
              },
            ],
          },
        },
        {
          role: "tool",
          message: {
            content: [{ type: "tool_result", tool_use_id: "cursor-call-1", content: "Delivered" }],
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
    expect(replay.meta.provider).toBe("cursor");
    expect(replay.meta.stats.userPrompts).toBe(1);
    expect(replay.scenes).toMatchObject([
      { type: "user-prompt", content: prompt },
      { type: "text-response", content: reply },
      { type: "tool-call", toolName: "send_message", result: "Delivered" },
    ]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
