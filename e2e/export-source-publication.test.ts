import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it.each(["cloud", "gist"])(
  "keeps %s publication links with the saved snapshot instead of a reparsed source",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-publication-scope-"));
    try {
      const source = join(root, "source.jsonl"),
        env = {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CODEX_HOME: join(root, "missing-codex"),
          VIBE_REPLAY_CONFIG: join(root, "missing.json"),
          VIBE_REPLAY_TELEMETRY: "0",
        },
        run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
      await writeFile(
        source,
        [
          { type: "session_meta", payload: { id: "publication-scope", cwd: root } },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Fresh source task" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      const fresh = JSON.parse(
          (await run(["export", source, "--format", "json", "--stdout"])).stdout,
        ),
        saved = join(root, ".vibe-replay", fresh.meta.slug),
        url =
          kind === "cloud"
            ? "https://vibe-replay.com/r/old-snapshot"
            : "https://vibe-replay.com/view/old-gist";
      await mkdir(saved, { recursive: true });
      await writeFile(
        join(saved, "replay.json"),
        JSON.stringify({
          ...fresh,
          scenes: [{ type: "user-prompt", content: "Saved snapshot task" }],
        }),
      );
      const metadata = join(
        saved,
        kind === "cloud" ? ".vibe-replay-cloud.json" : ".vibe-replay-gist.json",
      );
      await writeFile(
        metadata,
        JSON.stringify(
          kind === "cloud"
            ? { id: "old", url, expiresAt: "2099-01-01T00:00:00Z" }
            : { gistId: "old", filename: "replay.html", viewerUrl: url },
        ),
      );
      const paths = [source, join(saved, "replay.json"), metadata],
        before = await Promise.all(paths.map((path) => readFile(path)));
      const stdout = (await run(["export", source, "--stdout"])).stdout;
      expect(stdout).toContain("Fresh source task");
      expect(stdout).not.toContain(url);
      const output = JSON.parse(
          (await run(["export", source, "--output", join(root, "export"), "--json"])).stdout,
        ),
        written = await readFile(output.path, "utf8");
      expect(written).toContain("Fresh source task");
      expect(written).not.toContain(url);
      const snapshot = (await run(["export", saved, "--stdout"])).stdout;
      expect(snapshot).toContain("Saved snapshot task");
      expect(snapshot).toContain(url);
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
