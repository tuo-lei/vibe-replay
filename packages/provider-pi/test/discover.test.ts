import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPiSessions } from "../src/pi/discover.js";

const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("discoverPiSessions", () => {
  it("counts harness bash executions and apply_patch edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-pi-discover-"));
    tempDirs.push(root);
    const projectDir = join(root, "--Users-test-project--");
    await mkdir(projectDir, { recursive: true });
    const path = join(projectDir, "2026-01-01T00-00-00-000Z_session.jsonl");
    const lines = [
      {
        type: "session",
        version: 3,
        id: "pi-discovery-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/Users/test/project",
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix auth" }] },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "gpt-5.5",
          content: [
            {
              type: "toolCall",
              id: "patch-1",
              name: "apply_patch",
              arguments: { input: "*** Begin Patch\n*** Add File: auth.ts\n+ok\n*** End Patch" },
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "bashExecution", command: "pnpm test", output: "ok", exitCode: 0 },
      },
    ];
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
    process.env.PI_CODING_AGENT_SESSION_DIR = root;

    const sessions = await discoverPiSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "pi-discovery-session",
      promptCount: 1,
      toolCallCount: 2,
      editCountEst: 1,
      model: "gpt-5.5",
    });
  });
});
