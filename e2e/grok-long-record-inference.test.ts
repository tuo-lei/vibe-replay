import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it("reads a complete initial Grok record beyond the short header", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-grok-inference-"));
  try {
    const source = join(root, "copy.jsonl");
    const rows = [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: `[SAND_HIDDEN_PROMPT][first run] hidden bootstrap${  "x".repeat(200_000)}`,
            },
          ],
        },
      },
      {
        role: "user",
        message: { content: [{ type: "text", text: "[t0u] Investigate the deploy" }] },
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
});

it("requires an explicit provider when the initial record exceeds the bounded probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-grok-probe-bound-"));
  try {
    const source = join(root, "copy.jsonl");
    await writeFile(
      source,
      [
        {
          role: "user",
          message: {
            content: [{ type: "text", text: `[SAND_HIDDEN_PROMPT]${  "x".repeat(1_200_000)}` }],
          },
        },
        {
          role: "user",
          message: { content: [{ type: "text", text: "[t0u] Investigate the deploy" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
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
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      },
      args = [cli, "export", source, "--format", "json", "--stdout"],
      before = await readFile(source);
    await expect(exec(process.execPath, args, { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Specify --provider"),
    });
    const replay = JSON.parse(
      (await exec(process.execPath, [...args, "--provider", "grok-bot"], { env })).stdout,
    );
    expect(replay.meta.provider).toBe("grok-bot");
    expect(replay.scenes).toMatchObject([
      { type: "user-prompt", content: "Investigate the deploy" },
      { type: "text-response", content: "Visible reply" },
    ]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a known Codex header authoritative even beyond the ambiguous-record bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-known-long-header-"));
  try {
    const source = join(root, "copy.jsonl");
    await writeFile(
      source,
      [
        {
          type: "session_meta",
          timestamp: "2026-10-04T00:00:00Z",
          payload: {
            id: "11111111-1111-4111-8111-111111111111",
            cwd: root,
            base_instructions: "x".repeat(1_200_000),
          },
        },
        {
          type: "response_item",
          timestamp: "2026-10-04T00:00:01Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Investigate the deploy" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-10-04T00:00:02Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Visible reply" }],
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
      },
      replay = JSON.parse(
        (
          await exec(process.execPath, [cli, "export", source, "--format", "json", "--stdout"], {
            env,
          })
        ).stdout,
      );
    expect(replay.meta.provider).toBe("codex");
    expect(replay.scenes).toMatchObject([
      { type: "user-prompt", content: "Investigate the deploy" },
      { type: "text-response", content: "Visible reply" },
    ]);
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
