import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it("requires provider identity for indistinguishable id-less Cursor/Grok records", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-ambiguous-provider-"));
  try {
    const source = join(root, "copy.jsonl"),
      prompt = "[agent]\nImplement the handler",
      reply = "Normal assistant text";
    await writeFile(
      source,
      [
        { role: "user", message: { content: [{ type: "text", text: prompt }] } },
        { role: "user", message: { content: [{ type: "text", text: "Actual task" }] } },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: reply },
              {
                type: "tool_use",
                name: "send_message",
                input: { text: { content: "Messaging payload" } },
              },
            ],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const before = await readFile(source),
      env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      },
      args = [cli, "export", source, "--format", "json", "--stdout"];
    await expect(exec(process.execPath, args, { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Ambiguous Cursor/Grok Bot source"),
    });
    const cursor = JSON.parse(
      (await exec(process.execPath, [...args, "--provider", "cursor"], { env })).stdout,
    );
    expect(cursor.meta.provider).toBe("cursor");
    expect(cursor.meta.stats.userPrompts).toBe(2);
    expect(cursor.scenes).toMatchObject([
      { type: "user-prompt", content: prompt },
      { type: "user-prompt", content: "Actual task" },
      { type: "text-response", content: reply },
      { type: "tool-call", toolName: "send_message" },
    ]);
    const grok = JSON.parse(
      (await exec(process.execPath, [...args, "--provider", "grok-bot"], { env })).stdout,
    );
    expect(grok.meta.provider).toBe("grok-bot");
    expect(grok.meta.stats.userPrompts).toBe(1);
    expect(grok.scenes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "user-prompt", content: "Actual task" }),
        expect.objectContaining({ type: "thinking", content: reply }),
        expect.objectContaining({ type: "text-response", content: "Messaging payload" }),
      ]),
    );
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
