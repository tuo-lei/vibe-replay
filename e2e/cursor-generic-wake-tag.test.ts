import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each([
  "[routine]",
  "[agent]",
  "[inbound]",
  '[Answering your question tbs1: "Previous question"]',
  "[A background task just completed]",
  "[event]",
  "[first run]",
])("preserves a copied Cursor prompt beginning with %s", async (tag) => {
  const root = await mkdtemp(join(tmpdir(), "vibe-cursor-wake-tag-"));
  try {
    const source = join(root, "copy.jsonl"),
      prompt = `${tag}\nImplement the handler`,
      reply = "Normal Cursor assistant reply";
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
                id: "custom-message",
                name: "send_message",
                input: { message: "A custom messaging tool" },
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
    expect(replay.meta.provider).toBe("cursor");
    expect(replay.meta.stats.userPrompts).toBe(1);
    expect(replay.scenes).toMatchObject([
      { type: "user-prompt", content: prompt },
      { type: "text-response", content: reply },
      { type: "tool-call", toolName: "send_message" },
    ]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
