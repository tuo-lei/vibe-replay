import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it.each(["hidden", "progress"])(
  "keeps known Grok evidence before a long later %s record",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-grok-inference-"));
    try {
      const source = join(root, "copy.jsonl");
      const rows = [
        {
          role: "user",
          message: { content: [{ type: "text", text: "[t0u] Investigate the deploy" }] },
        },
        kind === "hidden"
          ? {
              role: "user",
              message: {
                content: [{ type: "text", text: `[SAND_HIDDEN_PROMPT]${  "x".repeat(1_200_000)}` }],
              },
            }
          : {
              type: "progress",
              data: {
                type: "assistant",
                uuid: "artifact-uuid",
                message: { content: [{ type: "text", text: "x".repeat(1_200_000) }] },
              },
            },
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
      ];
      await writeFile(source, rows.map((row) => JSON.stringify(row)).join("\n"));
      const before = await readFile(source);
      const { stdout } = await exec(
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
      );
      const replay = JSON.parse(stdout);
      expect(replay.meta.provider).toBe("grok-bot");
      expect(replay.scenes).toMatchObject([
        { type: "user-prompt", content: "Investigate the deploy" },
        { type: "thinking", content: "Private scratch" },
        { type: "text-response", content: "Visible reply" },
      ]);
      expect(stdout).not.toContain("hidden bootstrap");
      expect(stdout).not.toContain("[t0u]");
      expect(await readFile(source)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
