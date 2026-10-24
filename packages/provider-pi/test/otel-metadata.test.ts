import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePiSession } from "../src/pi/parser.js";

describe("Pi OTel metadata", () => {
  it("preserves usage timestamps and marks timestamp-derived tool durations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-pi-otel-"));
    const path = join(dir, "otel-metadata.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "otel-metadata",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Run a tool" },
      },
      {
        type: "message",
        id: "assistant1",
        parentId: "user1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "fixture-model",
          content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "message",
        id: "result1",
        parentId: "assistant1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          timestamp: "2026-01-01T00:00:04.000Z",
        },
      },
    ];

    try {
      await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const parsed = await parsePiSession(path);
      const tool = parsed.turns
        .flatMap((turn) => turn.blocks)
        .find((block) => block.type === "tool_use");

      expect(parsed.turnStats?.[0]).toMatchObject({ timestamp: "2026-01-01T00:00:02.000Z" });
      expect(tool).toMatchObject({
        type: "tool_use",
        _durationMs: 2_000,
        _durationSource: "timestamp",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
