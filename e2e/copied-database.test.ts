import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildHermesDb } from "../packages/provider-hermes/test/helpers/db.js";
import { buildOpencodeDb } from "../packages/provider-opencode/test/helpers/db.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each(["hermes", "opencode"])(
  "resolves sessions from a copied %s database outside discovery roots",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-copied-db-"));
    try {
      const source = join(root, "copy.snapshot");
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        HERMES_HOME: join(root, "missing-home"),
        OPENCODE_DATA: join(root, "missing-data"),
        VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
        VIBE_REPLAY_TELEMETRY: "off",
      };
      const run = (args: string[]) => exec(process.execPath, [cli, ...args], { env });
      async function seed(ids: string[]) {
        const db =
          provider === "hermes"
            ? await buildHermesDb({
                sessions: ids.map((id) => ({ id, cwd: root })),
                messages: ids.map((id, index) => ({
                  id: index + 1,
                  sessionId: id,
                  role: "user" as const,
                  content: `Copied task ${id}`,
                })),
              })
            : await buildOpencodeDb({
                session: ids.map((id) => ({ id })),
                messages: ids.map((id) => ({
                  id: `user-${id}`,
                  sessionId: id,
                  role: "user",
                  parts: [{ type: "text", text: `Copied task ${id}` }],
                })),
              });
        try {
          await writeFile(source, db.export());
        } finally {
          db.close();
        }
      }
      await seed(["copy-first"]);
      const before = await readFile(source);
      for (const scope of [[], ["--provider", provider]]) {
        const { stdout } = await run(["inspect", source, ...scope, "--json"]);
        expect(JSON.parse(stdout)).toMatchObject({ provider, sessionId: "copy-first" });
      }
      expect((await run(["export", source, "--stdout"])).stdout).toContain(
        "Copied task copy-first",
      );
      expect(
        JSON.parse((await run(["share", source, "--dry-run", "--json"])).stdout).uploaded,
      ).toBe(false);
      expect(await readFile(source)).toEqual(before);
      await seed(["copy-first", "copy-second"]);
      const multi = await readFile(source);
      await expect(run(["inspect", source, "--json"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Ambiguous"),
      });
      const { stdout } = await run(["inspect", `${source}#session:copy-second`, "--json"]);
      expect(JSON.parse(stdout)).toMatchObject({ provider, sessionId: "copy-second" });
      expect(await readFile(source)).toEqual(multi);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
