import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each([
  ["native", "send_message"],
  ["native", "communicate_update"],
  ["copied", "send_message"],
  ["copied", "communicate_update"],
])("preserves %s Cursor custom tool %s", async (kind, tool) => {
  const root = await mkdtemp(join(tmpdir(), "vibe-marker-discussion-"));
  try {
    const source =
      kind === "native"
        ? join(
            root,
            ".cursor/projects/project/agent-transcripts/11111111-1111-4111-8111-111111111111.jsonl",
          )
        : join(root, "copy.jsonl");
    await mkdir(dirname(source), { recursive: true });
    const prompt = "Use the custom messaging tool",
      reply = "Normal Cursor assistant text";
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
                id: "custom",
                name: tool,
                input: { text: { content: "Custom tool payload" } },
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
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
    expect(replay.meta.provider).toBe("cursor");
    expect(replay.scenes).toMatchObject([
      { type: "user-prompt", content: prompt },
      { type: "text-response", content: reply },
      { type: "tool-call", toolName: tool },
    ]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
