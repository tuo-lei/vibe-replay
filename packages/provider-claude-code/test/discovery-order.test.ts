import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { discoverClaudeCodeSessions, extractSessionInfo } from "../src/claude-code/discover.js";

it("retains sequential traversal results and live freshness across project batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibe-replay-discovery-order-"));
  try {
    for (let index = 0; index < 9; index++) {
      const directory = join(root, `project-${index}`);
      await mkdir(directory);
      for (let file = 0; file < 2; file++) {
        const sessionId = `session-${index}-${file}`;
        const lines = [
          JSON.stringify({
            type: "user",
            sessionId,
            cwd: "/example/project",
            timestamp: "2026-01-01T00:00:00Z",
            message: { role: "user", content: `Inspect test session ${sessionId}` },
          }),
        ];
        for (let record = 0; record < index * 50; record++)
          lines.push(JSON.stringify({ type: "system", timestamp: "2026-01-01T00:00:00Z" }));
        lines.push(
          JSON.stringify({
            type: "custom-title",
            customTitle: `Title ${sessionId}`,
            timestamp: "2026-01-01T00:00:00Z",
          }),
        );
        await writeFile(join(directory, `${sessionId}.jsonl`), lines.join("\n"));
      }
    }
    await writeFile(join(root, "not-a-project"), "ignored");
    const expected = [];
    for (const directory of await readdir(root)) {
      const path = join(root, directory);
      if (!(await stat(path)).isDirectory()) continue;
      for (const file of await readdir(path)) {
        const filePath = join(path, file);
        const info = await extractSessionInfo(filePath, (await stat(filePath)).size, directory);
        expect(info).not.toBeNull();
        expected.push({ ...info!, gitRepo: undefined });
      }
    }
    expect(await discoverClaudeCodeSessions(root, false)).toEqual(expected);
    const firstPath = join(root, "project-0", "session-0-0.jsonl");
    await appendFile(
      firstPath,
      `\n${JSON.stringify({ type: "custom-title", customTitle: "Renamed session", timestamp: "2026-01-02T00:00:00Z" })}`,
    );
    const refreshed = await discoverClaudeCodeSessions(root, false);
    expect(refreshed).toHaveLength(18);
    expect(refreshed[0]).toMatchObject({
      sessionId: "session-0-0",
      title: "Renamed session",
      timestamp: "2026-01-02T00:00:00Z",
      lineCount: 3,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
