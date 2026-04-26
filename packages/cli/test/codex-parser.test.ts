import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCodexSessionInfo } from "../src/providers/codex/discover.js";
import { parseCodexLines } from "../src/providers/codex/parser.js";
import { transformToReplay } from "../src/transform.js";

const lines = [
  {
    timestamp: "2026-04-26T05:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "codex-session-1",
      timestamp: "2026-04-26T05:00:00.000Z",
      cwd: "/Users/test/project",
      originator: "Codex CLI",
      cli_version: "0.125.0",
      source: "cli",
      git: { branch: "main" },
    },
  },
  {
    timestamp: "2026-04-26T05:00:00.100Z",
    type: "turn_context",
    payload: { model: "gpt-5.4", effort: "high", approval_policy: "never" },
  },
  {
    timestamp: "2026-04-26T05:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Please update the auth flow\n" },
  },
  {
    timestamp: "2026-04-26T05:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I'll inspect the code first." }],
    },
  },
  {
    timestamp: "2026-04-26T05:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call_1",
      arguments: JSON.stringify({ cmd: "pnpm test", workdir: "/Users/test/project" }),
    },
  },
  {
    timestamp: "2026-04-26T05:00:05.000Z",
    type: "event_msg",
    payload: {
      type: "exec_command_end",
      call_id: "call_1",
      aggregated_output: "tests passed",
      exit_code: 0,
      status: "completed",
      duration: { secs: 2, nanos: 0 },
    },
  },
  {
    timestamp: "2026-04-26T05:00:05.100Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 300,
          output_tokens: 50,
          total_tokens: 1050,
        },
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 300,
          output_tokens: 50,
          total_tokens: 1050,
        },
      },
    },
  },
].map((line) => JSON.stringify(line));

describe("Codex parser", () => {
  it("parses Codex rollout JSONL into replay turns", () => {
    const result = parseCodexLines(lines);

    expect(result.sessionId).toBe("codex-session-1");
    expect(result.cwd).toBe("/Users/test/project");
    expect(result.model).toBe("gpt-5.4");
    expect(result.gitBranch).toBe("main");
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 700,
      cacheReadTokens: 300,
      outputTokens: 50,
    });

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "Bash",
      _result: expect.stringContaining("tests passed"),
      _durationMs: 2000,
    });
  });

  it("transforms Codex tool calls into replay scenes", () => {
    const parsed = parseCodexLines(lines);
    const replay = transformToReplay(parsed, "codex", "~/project");

    expect(replay.meta.provider).toBe("codex");
    expect(replay.scenes.some((scene) => scene.type === "user-prompt")).toBe(true);
    const bash = replay.scenes.find(
      (scene) => scene.type === "tool-call" && scene.toolName === "Bash",
    );
    expect(bash?.type === "tool-call" && bash.bashOutput?.command).toBe("pnpm test");
  });

  it("strips Codex user prompt prefixes and parses local shell calls", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T06:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-2", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T06:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "## My request for Codex: run the tests",
          },
        },
        {
          timestamp: "2026-04-26T06:00:02.000Z",
          type: "response_item",
          payload: {
            type: "local_shell_call",
            call_id: "shell_1",
            status: "completed",
            action: {
              type: "exec",
              command: ["pnpm", "test"],
              working_directory: "/Users/test/project",
            },
          },
        },
        {
          timestamp: "2026-04-26T06:00:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "shell_1",
            output: "ok",
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turns[0].blocks[0]).toMatchObject({
      type: "text",
      text: "run the tests",
    });

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "Bash",
      input: { command: "pnpm test", workdir: "/Users/test/project" },
      _result: "ok",
    });
  });

  it("converts Codex local image paths to data URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-"));
    const imagePath = join(dir, "tiny.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

    try {
      const result = parseCodexLines(
        [
          {
            timestamp: "2026-04-26T07:00:00.000Z",
            type: "session_meta",
            payload: { id: "codex-session-3", cwd: "/Users/test/project", source: "cli" },
          },
          {
            timestamp: "2026-04-26T07:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "",
              local_images: [imagePath],
            },
          },
        ].map((line) => JSON.stringify(line)),
      );

      const imageBlock = result.turns[0].blocks.find((block) => block.type === "_user_images");
      expect(imageBlock).toMatchObject({
        type: "_user_images",
        images: [expect.stringMatching(/^data:image\/png;base64,/)],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes Codex edit tool names for scan counters", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T08:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-4", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T08:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "edit",
            call_id: "edit_1",
            arguments: JSON.stringify({ file_path: "src/app.ts" }),
          },
        },
        {
          timestamp: "2026-04-26T08:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "write_file",
            call_id: "write_1",
            arguments: JSON.stringify({ path: "src/new.ts" }),
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(
      result.turns.flatMap((turn) =>
        turn.blocks.flatMap((block) => (block.type === "tool_use" ? [block.name] : [])),
      ),
    ).toEqual(["Edit", "Write"]);
  });

  it("discovers image-only Codex prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-discover-"));
    const rolloutPath = join(dir, "rollout-2026-04-26T09-00-00-codex-session-5.jsonl");
    const content = [
      {
        timestamp: "2026-04-26T09:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-5", cwd: "/Users/test/project", source: "cli" },
      },
      {
        timestamp: "2026-04-26T09:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          local_images: ["/Users/test/screenshot.png"],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(rolloutPath, content);

    try {
      const info = await extractCodexSessionInfo(rolloutPath, Buffer.byteLength(content));

      expect(info).toMatchObject({
        sessionId: "codex-session-5",
        firstPrompt: "[Image]",
        promptCount: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses Codex reasoning, compaction, title, and web search events", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-6", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "thread_name_updated", thread_name: "Ship Codex support" },
        },
        {
          timestamp: "2026-04-26T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "agent_reasoning", text: "Need to inspect the schema." },
        },
        {
          timestamp: "2026-04-26T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "text", text: "Schema confirmed." }],
          },
        },
        {
          timestamp: "2026-04-26T10:00:04.000Z",
          type: "response_item",
          payload: { type: "compaction" },
        },
        {
          timestamp: "2026-04-26T10:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "web_1",
            query: "Codex rollout schema",
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.title).toBe("Ship Codex support");
    expect(result.compactions).toMatchObject([{ trigger: "codex" }]);

    const blocks = result.turns.flatMap((turn) => turn.blocks);
    expect(blocks.filter((block) => block.type === "thinking")).toHaveLength(2);
    expect(blocks.find((block) => block.type === "tool_use")).toMatchObject({
      type: "tool_use",
      name: "web_search",
      _result: "[Search: Codex rollout schema]",
    });
  });
});
