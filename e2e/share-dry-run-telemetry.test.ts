import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../packages/cli/dist/index.js");

it.each([false, true])(
  "share dry-run has no telemetry writes or HTTP requests (existing state: %s)",
  async (existing) => {
    const root = await mkdtemp(join(tmpdir(), "vibe-dry-run-telemetry-"));
    try {
      const telemetry = join(root, "telemetry.json");
      const preload = join(root, "fetch-probe.cjs");
      await writeFile(
        join(root, "replay.json"),
        JSON.stringify({ meta: { sessionId: "dry-run", provider: "codex" }, scenes: [] }),
      );
      await writeFile(
        preload,
        'globalThis.fetch = async () => { require("node:fs").writeFileSync(process.env.FETCH_PROBE_FILE, "HTTP request"); return new Response("{}", {status: 200}); };',
      );
      if (existing)
        await writeFile(
          telemetry,
          JSON.stringify({
            version: 1,
            installationId: "11111111-1111-4111-8111-111111111111",
            enabled: true,
            notified: false,
            createdAt: "2026-10-04T00:00:00Z",
          }),
        );
      const before = Object.fromEntries(
        await Promise.all(
          (await readdir(root)).map(async (name) => [
            name,
            await readFile(join(root, name), "utf-8"),
          ]),
        ),
      );
      const { stdout, stderr } = await exec(
        process.execPath,
        ["--require", preload, cli, "share", root, "--dry-run", "--json"],
        {
          env: {
            ...process.env,
            CI: "",
            DO_NOT_TRACK: "",
            VIBE_REPLAY_TELEMETRY: "",
            VIBE_REPLAY_DEV: "",
            VIBE_REPLAY_DEV_MENU: "",
            VIBE_REPLAY_TELEMETRY_FILE: telemetry,
            VIBE_REPLAY_API_URL: "https://example.invalid",
            FETCH_PROBE_FILE: join(root, "request-probe.txt"),
          },
        },
      );
      expect(JSON.parse(stdout).uploaded).toBe(false);
      expect(stderr).toBe("");
      const after = Object.fromEntries(
        await Promise.all(
          (await readdir(root)).map(async (name) => [
            name,
            await readFile(join(root, name), "utf-8"),
          ]),
        ),
      );
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
