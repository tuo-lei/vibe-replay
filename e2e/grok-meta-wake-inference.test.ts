import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it.each([
  ["[routine]", 1],
  ["[agent]", 1],
  ["[inbound]", 2],
  ['[Answering your question tbs1: "Previous question"]', 2],
  ["[A background task just completed]", 1],
  ["[event]", 1],
  ["[first run]", 1],
])(
  "requires explicit provider identity for an ambiguous bare Grok %s wake",
  async (prefix, prompts) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-meta-inference-"));
    try {
      const source = join(root, "copy.jsonl");
      await writeFile(
        source,
        [
          { role: "user", message: { content: [{ type: "text", text: `${prefix}\nWake body` }] } },
          { role: "user", message: { content: [{ type: "text", text: "Actual task" }] } },
          {
            role: "assistant",
            message: {
              content: [
                { type: "text", text: "Private scratch" },
                {
                  type: "tool_use",
                  name: "send_message",
                  input: { text: { content: "Visible reply" } },
                },
              ],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      const before = await readFile(source),
        env = {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          VIBE_REPLAY_CONFIG: join(root, "missing.json"),
          VIBE_REPLAY_TELEMETRY: "0",
        };
      await expect(
        exec(process.execPath, [cli, "export", source, "--format", "json", "--stdout"], { env }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Ambiguous Cursor/Grok Bot source"),
      });
      const replay = JSON.parse(
        (
          await exec(
            process.execPath,
            [cli, "export", source, "--provider", "grok-bot", "--format", "json", "--stdout"],
            { env },
          )
        ).stdout,
      );
      expect(replay.meta.provider).toBe("grok-bot");
      expect(replay.meta.stats.userPrompts).toBe(prompts);
      expect(replay.scenes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "user-prompt", content: "Actual task" }),
          expect.objectContaining({ type: "thinking", content: "Private scratch" }),
          expect.objectContaining({ type: "text-response", content: "Visible reply" }),
        ]),
      );
      expect(await readFile(source)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
