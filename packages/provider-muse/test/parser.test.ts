import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@vibe-replay/provider-contract";
import { parseMuseLines, parseMuseSession } from "../src/muse/parser.js";
import { transformToReplay } from "./helpers/transform.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function header(createdAt = "2026-09-18T10:00:00Z"): string {
  return JSON.stringify({
    type: "session_header",
    version: 1,
    session_id: "agent-test-1",
    agent_id: "agent-test-1",
    created_at: createdAt,
  });
}

function item(item: unknown, createdAt = "2026-09-18T10:01:00Z"): string {
  return JSON.stringify({ type: "item", seq: 1, source: "runtime", item, created_at: createdAt });
}

function toolUseBlock(turn: { blocks: ContentBlock[] }, name: string): ContentBlock {
  const block = turn.blocks.find((b) => b.type === "tool_use" && b.name === name);
  if (!block) throw new Error(`expected tool_use block named ${name}`);
  return block;
}

describe("parseMuseLines", () => {
  it("builds user/assistant turns from messages, thinking, and commentary", () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "user", text: "Refactor the auth module" }),
      item({ type: "commentary_text", text: "On it, taking a look." }),
      item({ type: "thinking", thinking: "Need to check the current structure first." }),
      item({ type: "message", role: "assistant", text: "Here is my plan." }),
      item({ type: "message", role: "user", text: "Go ahead" }),
    ]);

    expect(parsed.sessionId).toBe("agent-test-1");
    expect(parsed.title).toBe("Refactor the auth module");
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[1].role).toBe("assistant");
    expect(parsed.turns[1].blocks).toHaveLength(3);
    expect(parsed.turns[1].blocks[0]).toMatchObject({
      type: "text",
      text: "On it, taking a look.",
    });
    expect(parsed.turns[1].blocks[1]).toMatchObject({
      type: "thinking",
      thinking: "Need to check the current structure first.",
    });
    expect(parsed.turns[1].blocks[2]).toMatchObject({ type: "text", text: "Here is my plan." });
    expect(parsed.turns[2].role).toBe("user");
  });

  it("pairs function_call_output with its function_call by call_id", () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "user", text: "Run the tests" }),
      item({
        type: "function_call",
        call_id: "call-1",
        name: "exec",
        arguments: JSON.stringify({ command: "pnpm test" }),
      }),
      item({
        type: "function_call_output",
        call_id: "call-1",
        output: '{"exit":0}',
        success: true,
      }),
      item({
        type: "function_call",
        call_id: "call-2",
        name: "write",
        arguments: JSON.stringify({ path: "/tmp/a.txt" }),
      }),
      item({
        type: "function_call_output",
        call_id: "call-2",
        output: "permission denied",
        success: false,
      }),
    ]);

    const assistantTurn = parsed.turns.find((turn) => turn.role === "assistant");
    expect(assistantTurn).toBeDefined();
    const exec = toolUseBlock(assistantTurn!, "Bash");
    expect(exec.type).toBe("tool_use");
    expect(exec.type === "tool_use" && exec.id).toBe("call-1");
    expect(exec.type === "tool_use" && exec.input).toEqual({ command: "pnpm test" });
    expect(exec._hasResult).toBe(true);
    expect(exec._isError).toBe(false);
    expect(exec._result).toBe('{"exit":0}');

    const write = toolUseBlock(assistantTurn!, "Write");
    expect(write._isError).toBe(true);
    expect(write._result).toBe("permission denied");
  });

  it("reads text from message_parts and skips developer messages", () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "developer", text: "You are a coding assistant." }),
      item({
        type: "message_parts",
        role: "user",
        parts: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      }),
    ]);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[0].blocks).toEqual([{ type: "text", text: "First part Second part" }]);
  });

  it("records compaction checkpoints as compaction metadata, not turns", () => {
    const parsed = parseMuseLines(
      [
        header(),
        item({ type: "message", role: "user", text: "Hello" }),
        JSON.stringify({
          type: "compaction_checkpoint",
          compaction_id: 1,
          trigger: "threshold",
          created_at: "2026-09-18T10:05:00Z",
          summary: "a very long summary that should not appear in the replay",
        }),
      ],
      { now: () => "2026-09-18T10:06:00Z" },
    );

    expect(parsed.compactions).toHaveLength(1);
    expect(parsed.compactions![0]).toMatchObject({
      timestamp: "2026-09-18T10:05:00Z",
      trigger: "threshold",
    });
    expect(JSON.stringify(parsed.turns)).not.toContain("very long summary");
  });

  it("collects warnings for malformed lines and skips unknown record types", () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "user", text: "Hello" }),
      "{not valid json",
      JSON.stringify({ type: "weird_record", created_at: "2026-09-18T10:02:00Z" }),
      JSON.stringify({
        type: "item",
        seq: 9,
        item: { type: "hologram", role: "user" },
        created_at: "2026-09-18T10:03:00Z",
      }),
    ]);

    expect(parsed.turns).toHaveLength(1);
    const kinds = (parsed.parseWarnings ?? []).map((w) => w.kind);
    expect(kinds).toEqual(["malformed-json"]);
  });

  it("derives start/end time and duration from record timestamps", () => {
    const parsed = parseMuseLines([
      header("2026-09-18T10:00:00Z"),
      item({ type: "message", role: "user", text: "Hi" }, "2026-09-18T10:01:00Z"),
      item({ type: "message", role: "assistant", text: "Hey" }, "2026-09-18T10:31:00Z"),
    ]);

    expect(parsed.startTime).toBe("2026-09-18T10:00:00Z");
    expect(parsed.endTime).toBe("2026-09-18T10:31:00Z");
    expect(parsed.totalDurationMs).toBeGreaterThan(0);
  });

  it("prefers sessionInfo title and slug when provided", () => {
    const parsed = parseMuseLines([header(), item({ type: "message", role: "user", text: "Hi" })], {
      sessionInfo: {
        provider: "muse",
        sessionId: "agent-test-1",
        slug: "custom-slug",
        title: "Custom title",
        project: "Muse",
        cwd: "",
        version: "1",
        timestamp: "2026-09-18T10:01:00Z",
        lineCount: 2,
        fileSize: 10,
        filePath: "/tmp/x.jsonl",
        filePaths: ["/tmp/x.jsonl"],
        firstPrompt: "Hi",
      },
    });

    expect(parsed.slug).toBe("custom-slug");
    expect(parsed.title).toBe("Custom title");
  });
});

describe("parseMuseSession", () => {
  it("reads a transcript file and resolves the model from sessions.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibe-muse-parser-"));
    tempDirs.push(root);
    const sessionsDir = join(root, "agent-x", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const transcriptPath = join(sessionsDir, "agent-x.jsonl");
    await writeFile(
      transcriptPath,
      [
        header(),
        item({ type: "message", role: "user", text: "Hello from file" }),
        item({
          type: "function_call",
          call_id: "c1",
          name: "exec",
          arguments: JSON.stringify({ command: "ls" }),
        }),
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            session_id: "agent-test-1",
            context_window_usage: { model_id: "ipnext/avocado-5.16-v4" },
          },
        ],
      }),
      "utf-8",
    );

    const parsed = await parseMuseSession(transcriptPath);
    expect(parsed.model).toBe("ipnext/avocado-5.16-v4");
    expect(parsed.turns.some((turn) => turn.role === "user")).toBe(true);
    expect(parsed.dataSource).toBe("jsonl");
  });

  it("produces a replay with correct provider and stats", async () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "user", text: "Build the feature" }),
      item({
        type: "function_call",
        call_id: "c1",
        name: "exec",
        arguments: JSON.stringify({ command: "pnpm build" }),
      }),
      item({
        type: "function_call_output",
        call_id: "c1",
        output: '{"exit":0}',
        success: true,
      }),
      item({ type: "message", role: "assistant", text: "Built successfully." }),
    ]);

    const replay = transformToReplay(parsed, "muse", "~");
    expect(replay.meta.provider).toBe("muse");
    expect(replay.meta.stats.userPrompts).toBe(1);
    expect(replay.meta.stats.toolCalls).toBe(1);
    const toolScene = replay.scenes.find((scene) => scene.type === "tool-call");
    expect(toolScene?.type).toBe("tool-call");
  });

  it("warns and skips non-object JSON lines instead of throwing", () => {
    const parsed = parseMuseLines([
      header(),
      "null",
      "[1,2]",
      item({ type: "message", role: "user", text: "Still here" }),
    ]);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].role).toBe("user");
    // Both non-object lines collapse into one deduplicated warning.
    expect(parsed.parseWarnings?.length).toBe(1);
    expect(parsed.parseWarnings?.[0].kind).toBe("malformed-json");
    expect(parsed.parseWarnings?.[0].count).toBe(2);
  });

  it("normalizes built-in tool names and args for downstream rendering", () => {
    const parsed = parseMuseLines([
      header(),
      item({ type: "message", role: "user", text: "Fix it" }),
      item({
        type: "function_call",
        call_id: "c1",
        name: "edit",
        arguments: JSON.stringify({ path: "/tmp/a.ts", old_text: "a", new_text: "b" }),
      }),
    ]);

    const assistantTurn = parsed.turns.find((turn) => turn.role === "assistant");
    const block = toolUseBlock(assistantTurn!, "Edit");
    expect(block.type === "tool_use" && block.input).toEqual({
      file_path: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
    });
  });

  it("skips runtime-injected prompts for the title but keeps them as turns", () => {
    const injected = JSON.stringify({
      type: "item",
      seq: 1,
      source: "runtime.self_improvement",
      item: { type: "message", role: "user", text: "## Step instructions\nDo background work" },
      created_at: "2026-09-18T10:01:00Z",
    });
    const parsed = parseMuseLines([
      header(),
      injected,
      item({ type: "message", role: "user", text: "Real user prompt" }),
    ]);

    expect(parsed.title).toBe("Real user prompt");
    expect(parsed.turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  });

  it("falls back to an empty title when every prompt is runtime-injected", () => {
    const injected = JSON.stringify({
      type: "item",
      seq: 1,
      source: "scheduler.cron",
      item: { type: "message", role: "user", text: "[WORKER TASK]\njob_id: nightly" },
      created_at: "2026-09-18T10:01:00Z",
    });
    const parsed = parseMuseLines([header(), injected]);

    expect(parsed.title).toBeUndefined();
    expect(parsed.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
});
