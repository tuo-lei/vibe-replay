import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each(["claude-code", "codex", "pi", "cursor"])(
  "selects a copied %s transcript outside discovery roots",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-copied-transcript-"));
    try {
      const source = join(root, "copy.jsonl");
      const timestamp = "2026-10-04T00:00:00Z",
        prompt = "Resume the copied task";
      const user = { role: "user", content: [{ type: "text", text: prompt }] };
      const rows =
        provider === "claude-code"
          ? [
              {
                type: "user",
                uuid: "user-one",
                sessionId: "copied-claude",
                cwd: root,
                timestamp,
                message: user,
              },
            ]
          : provider === "codex"
            ? [
                { type: "session_meta", payload: { id: "copied-codex", cwd: root, timestamp } },
                {
                  type: "response_item",
                  timestamp,
                  payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: prompt }],
                  },
                },
              ]
            : provider === "pi"
              ? [
                  { type: "session", version: 3, id: "copied-pi", cwd: root, timestamp },
                  { type: "message", id: "user-one", parentId: null, timestamp, message: user },
                ]
              : [{ role: "user", message: { content: [{ type: "text", text: prompt }] } }];
      await writeFile(source, `${rows.map((row) => JSON.stringify(row)).join("\n")  }\n`);
      const before = await readFile(source);
      for (const scope of [[], ["--provider", provider]]) {
        const { stdout } = await exec(
          process.execPath,
          [cli, "sessions", "--session", source, ...scope, "--json"],
          {
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
              OPENCODE_DATA: join(root, "missing-data"),
              HERMES_HOME: join(root, "missing-home"),
              VIBE_REPLAY_TELEMETRY: "off",
            },
          },
        );
        const result = JSON.parse(stdout);
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ provider, firstPrompt: prompt });
      }
      expect(await readFile(source)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
