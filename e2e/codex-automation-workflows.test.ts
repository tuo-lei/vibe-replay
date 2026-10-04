import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it("accepts copied automation-only Codex sessions with zero human prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-automation-source-"));
  try {
    const source = join(root, "copy.jsonl");
    await writeFile(
      source,
      [
        { type: "session_meta", payload: { id: "automation-only", cwd: root } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<heartbeat><automation_id>review</automation_id><instructions>Check the current PR.</instructions></heartbeat>",
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const before = await readFile(source);
    const run = (args: string[]) =>
      exec(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CODEX_HOME: join(root, "missing-codex"),
          VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
          VIBE_REPLAY_TELEMETRY: "off",
        },
      });
    const listed = JSON.parse(
      (await run(["sessions", "--session", source, "--provider", "codex", "--json"])).stdout,
    );
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      provider: "codex",
      firstPrompt: "",
      promptCount: 0,
      automationTriggerCount: 1,
    });
    const inspected = JSON.parse((await run(["inspect", source, "--json"])).stdout);
    expect(inspected.stats).toMatchObject({ userPrompts: 0, automationTriggerCount: 1 });
    const exported = JSON.parse(
      (await run(["export", source, "--format", "json", "--stdout"])).stdout,
    );
    expect(exported.meta.stats).toMatchObject({ userPrompts: 0, automationTriggerCount: 1 });
    expect(JSON.parse((await run(["share", source, "--dry-run", "--json"])).stdout)).toMatchObject({
      sessionId: "automation-only",
      uploaded: false,
    });
    expect(await readFile(source)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
