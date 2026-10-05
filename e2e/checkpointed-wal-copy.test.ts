import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  GLOBAL_STATE_IDS,
  globalStateDbBytes,
} from "../packages/provider-cursor/test/helpers/global-state-db.js";

const exec = promisify(execFile),
  cli = join(import.meta.dirname, "../packages/cli/dist/index.js");
it.each([true, false])(
  "exports a checkpointed WAL-mode copy without sidecars (native SQLite available: %s)",
  async (nativeSqlite) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-checkpointed-copy-"));
    try {
      const source = join(root, "copy #snapshot.db"),
        bytes = await globalStateDbBytes();
      // SQLite preserves WAL-mode header bytes after the final checkpoint removes sidecars.
      bytes[18] = 2;
      bytes[19] = 2;
      await writeFile(source, bytes);
      const marker = `${source}#session:${GLOBAL_STATE_IDS[0]}`;
      const env = {
        ...process.env,
        PATH: nativeSqlite ? process.env.PATH : "",
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, "AppData/Roaming"),
        LOCALAPPDATA: join(root, "AppData/Local"),
        VIBE_REPLAY_CONFIG: join(root, "missing.json"),
        VIBE_REPLAY_TELEMETRY: "0",
      };
      const { stdout } = await exec(process.execPath, [cli, "export", marker, "--stdout"], { env });
      expect(stdout).toContain("Fix readonly output 1");
      const preflight = await exec(
        process.execPath,
        [cli, "share", marker, "--dry-run", "--json"],
        { env },
      );
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        sessionId: GLOBAL_STATE_IDS[0],
        uploaded: false,
      });
      expect(await readdir(root)).toEqual(["copy #snapshot.db"]);
      expect(await readFile(source)).toEqual(Buffer.from(bytes));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
