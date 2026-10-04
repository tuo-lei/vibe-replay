import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  GLOBAL_STATE_IDS,
  globalStateDbBytes,
} from "../packages/provider-cursor/test/helpers/global-state-db.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

async function snapshot(root: string) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(root, { recursive: true })).sort().map(async (name) => {
        const path = join(root, name);
        return [
          name,
          (await stat(path)).isDirectory()
            ? "directory"
            : createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
        ];
      }),
    ),
  );
}

it.each(["share", "export"])(
  "%s by Cursor ID is read-only on a cold discovery cache",
  async (command) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-cli-read-only-"));
    try {
      const folder = join(root, "Library/Application Support/Cursor/User/globalStorage");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "state.vscdb"), await globalStateDbBytes());
      const preload = join(root, "fetch-probe.cjs");
      await writeFile(
        preload,
        'globalThis.fetch = async () => { require("node:fs").writeFileSync(process.env.FETCH_PROBE_FILE, "HTTP request"); return new Response("{}", {status: 200}); };',
      );
      const before = await snapshot(root);
      const args = command === "share" ? ["--dry-run", "--json"] : ["--stdout"];
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--require", preload, cli, command, GLOBAL_STATE_IDS[0], "--provider", "cursor", ...args],
        {
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            APPDATA: join(root, "AppData/Roaming"),
            LOCALAPPDATA: join(root, "AppData/Local"),
            VIBE_REPLAY_CONFIG: join(root, "missing-config.json"),
            VIBE_REPLAY_DISABLE_FILE_CACHE: "",
            CI: "",
            DO_NOT_TRACK: "",
            VIBE_REPLAY_TELEMETRY: "",
            VIBE_REPLAY_DEV: "",
            VIBE_REPLAY_DEV_MENU: "",
            VIBE_REPLAY_TELEMETRY_FILE: join(root, "telemetry.json"),
            VIBE_REPLAY_API_URL: "https://example.invalid",
            FETCH_PROBE_FILE: join(root, "request-probe.txt"),
          },
        },
      );
      if (command === "share") expect(JSON.parse(stdout).uploaded).toBe(false);
      else expect(stdout).toContain("Fix readonly output 1");
      expect(stderr).toBe("");
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
