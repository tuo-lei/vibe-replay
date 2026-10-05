import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it.each([true, false])(
  "shares the explicitly selected transcript despite a sibling replay (dry-run: %s)",
  async (dryRun) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-source-choice-"));
    try {
      const source = join(root, "transcript.jsonl"),
        replay = join(root, "replay.json");
      await writeFile(
        source,
        [
          { type: "session_meta", payload: { id: "explicit-source", cwd: root } },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Selected source task" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      await writeFile(
        replay,
        JSON.stringify({
          meta: {
            sessionId: "unrelated-replay",
            provider: "codex",
            stats: { userPrompts: 1, toolCalls: 0, sceneCount: 1 },
          },
          scenes: [{ type: "user-prompt", content: "Unrelated sibling task" }],
        }),
      );
      const before = [await readFile(source), await readFile(replay)];
      const { stdout } = await exec(
        process.execPath,
        [cli, "share", source, "--provider", "codex", "--json", ...(dryRun ? ["--dry-run"] : [])],
        {
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            CODEX_HOME: join(root, "missing-codex"),
            VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
            VIBE_REPLAY_TELEMETRY: "off",
          },
        },
      );
      const result = JSON.parse(stdout);
      expect(result.uploaded).toBe(false);
      if (dryRun) expect(result.sessionId).toBe("explicit-source");
      else {
        expect(result.mode).toBe("local-fallback");
        const html = await readFile(result.htmlPath, "utf-8");
        expect(html).toContain("Selected source task");
        expect(html).not.toContain("Unrelated sibling task");
      }
      expect([await readFile(source), await readFile(replay)]).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
