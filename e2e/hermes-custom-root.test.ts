import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { buildHermesDb } from "../packages/provider-hermes/test/helpers/db.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each(["inspect", "export", "share"])(
  "%s infers Hermes from a custom root's SQLite schema",
  async (command) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-custom-source-"));
    try {
      const db = await buildHermesDb({
        sessions: [{ id: "custom-root-session", title: "Custom root", cwd: root }],
        messages: [
          {
            id: 1,
            sessionId: "custom-root-session",
            role: "user",
            content: "Fix custom-root discovery",
            timestamp: 1800000000,
          },
        ],
      });
      const source = join(root, "state.db");
      try {
        await writeFile(source, db.export());
      } finally {
        db.close();
      }
      const before = await readFile(source);
      const args =
        command === "export"
          ? ["--stdout"]
          : command === "share"
            ? ["--dry-run", "--json"]
            : ["--json"];
      const { stdout } = await exec(process.execPath, [cli, command, source, ...args], {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          HERMES_HOME: root,
          VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
        },
      });
      if (command === "export") expect(stdout).toContain("Fix custom-root discovery");
      else if (command === "share") expect(JSON.parse(stdout).uploaded).toBe(false);
      else
        expect(JSON.parse(stdout)).toMatchObject({
          provider: "hermes",
          sessionId: "custom-root-session",
        });
      expect(await readFile(source)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
