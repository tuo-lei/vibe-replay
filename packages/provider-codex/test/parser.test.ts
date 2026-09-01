import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCodexSessionInfo } from "../src/codex/discover.js";
import { parseCodexLines } from "../src/codex/parser.js";
import { transformToReplay } from "./helpers/transform.js";

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
      memory_mode: "enabled",
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
        model_context_window: 258400,
      },
    },
  },
  {
    timestamp: "2026-04-26T05:00:06.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      duration_ms: 12345,
      turn_id: "turn-1",
    },
  },
].map((line) => JSON.stringify(line));

describe("Codex parser", () => {
  it("keeps tool search as a tool invocation rather than a skill activation", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T06:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-tool-search", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-04-26T06:00:01.000Z",
          type: "response_item",
          payload: {
            type: "tool_search_call",
            call_id: "search-1",
            arguments: { query: "github" },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.skillsUsed).toBeUndefined();
    expect(
      result.turns.flatMap((turn) => turn.blocks).filter((block) => block.type === "tool_use"),
    ).toHaveLength(1);
  });

  it("parses Codex rollout JSONL into replay turns", () => {
    const result = parseCodexLines(lines);

    expect(result.sessionId).toBe("codex-session-1");
    expect(result.cwd).toBe("/Users/test/project");
    expect(result.model).toBe("gpt-5.4");
    expect(result.gitBranch).toBe("main");
    expect(result.contextLimit).toBe(258400);
    expect(result.totalDurationMs).toBe(12345);
    expect(result.turnStats?.[0]?.durationMs).toBe(12345);
    expect(result.memoryMode).toBe("enabled");
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

  it("anchors an orphan exec completion duration at its result timestamp", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T05:10:00.000Z",
          type: "session_meta",
          payload: { id: "codex-orphan-exec", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-04-26T05:10:05.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "orphan-exec",
            aggregated_output: "done",
            exit_code: 0,
            duration: { secs: 5, nanos: 0 },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      _durationMs: 5000,
      _durationAnchor: "end",
    });
  });

  it("infers custom tool duration from paired call and output timestamps", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T05:20:00.000Z",
          type: "session_meta",
          payload: { id: "codex-custom-duration", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-04-26T05:20:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "custom-1",
            name: "custom_local_tool",
            input: { command: "pnpm test" },
          },
        },
        {
          timestamp: "2026-04-26T05:20:04.500Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "custom-1",
            output: "passed",
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      _durationMs: 3500,
      _durationSource: "timestamp",
    });
  });

  it("records malformed JSONL lines as parse warnings", () => {
    const result = parseCodexLines([...lines.slice(0, 2), "{not-json", ...lines.slice(2)]);

    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.parseWarnings).toEqual([
      expect.objectContaining({
        kind: "malformed-json",
        count: 1,
        source: "codex JSONL",
        firstLine: 3,
        message: "Skipped malformed JSONL line",
      }),
    ]);
  });

  it("transforms Codex tool calls into replay scenes", () => {
    const parsed = parseCodexLines(lines);
    const replay = transformToReplay(parsed, "codex", "~/project");

    expect(replay.meta.provider).toBe("codex");
    expect(replay.meta.memoryMode).toBe("enabled");
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

  it("converts Codex response-item image paths to data URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-content-image-"));
    const imagePath = join(dir, "tiny.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

    try {
      const result = parseCodexLines(
        [
          {
            timestamp: "2026-04-26T07:30:00.000Z",
            type: "session_meta",
            payload: { id: "codex-session-3b", cwd: "/Users/test/project", source: "app" },
          },
          {
            timestamp: "2026-04-26T07:30:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_image", path: imagePath }],
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

  it("parses Codex response-item local_image parts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-local-image-"));
    const imagePath = join(dir, "tiny.png");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

    try {
      const result = parseCodexLines(
        [
          {
            timestamp: "2026-04-26T07:40:00.000Z",
            type: "session_meta",
            payload: { id: "codex-session-3c", cwd: "/Users/test/project", source: "app" },
          },
          {
            timestamp: "2026-04-26T07:40:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "local_image", path: imagePath }],
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
      {
        timestamp: "2026-04-26T09:00:01.500Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          local_images: ["/Users/test/other-screenshot.png"],
        },
      },
      {
        timestamp: "2026-04-26T09:00:01.900Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              source: { media_type: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
            },
          ],
        },
      },
      {
        timestamp: "2026-04-26T09:00:02.300Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "local_image", path: "/Users/test/local-image.png" }],
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
        promptCount: 4,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers all Codex tool-call item variants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-discover-tools-"));
    const rolloutPath = join(dir, "rollout-2026-04-26T09-30-00-codex-session-tools.jsonl");
    const content = [
      {
        timestamp: "2026-04-26T09:30:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-tools", cwd: "/Users/test/project", source: "cli" },
      },
      {
        timestamp: "2026-04-26T09:30:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Run tools for this session." },
      },
      {
        timestamp: "2026-04-26T09:30:02.000Z",
        type: "response_item",
        payload: { type: "local_shell_call", call_id: "shell_1", action: { command: "pwd" } },
      },
      {
        timestamp: "2026-04-26T09:30:03.000Z",
        type: "response_item",
        payload: {
          type: "tool_search_call",
          call_id: "search_1",
          arguments: { query: "github" },
        },
      },
      {
        timestamp: "2026-04-26T09:30:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "apply_patch",
          call_id: "edit_1",
          arguments: JSON.stringify({ file_path: "src/app.ts" }),
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(rolloutPath, content);

    try {
      const info = await extractCodexSessionInfo(rolloutPath, Buffer.byteLength(content));

      expect(info).toMatchObject({
        sessionId: "codex-session-tools",
        toolCallCount: 3,
        editCountEst: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers response-item user messages when event messages are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-discover-response-user-"));
    const rolloutPath = join(dir, "rollout-2026-04-26T09-45-00-codex-session-response-user.jsonl");
    const content = [
      {
        timestamp: "2026-04-26T09:45:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-response-user", cwd: "/Users/test/project", source: "app" },
      },
      {
        timestamp: "2026-04-26T09:45:00.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/Users/test/project</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-05-02</current_date>\n  <timezone>America/Los_Angeles</timezone>\n</environment_context>\nOnly response item prompt.",
            },
          ],
        },
      },
      {
        timestamp: "2026-04-26T09:45:00.200Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "<permissions instructions>\nFilesystem sandboxing allows all commands.\nApproval policy is never.\n</permissions instructions>",
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(rolloutPath, content);

    try {
      const info = await extractCodexSessionInfo(rolloutPath, Buffer.byteLength(content));

      expect(info).toMatchObject({
        sessionId: "codex-session-response-user",
        firstPrompt: "Only response item prompt.",
        promptCount: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts repeated Codex discovery prompts after the dedupe window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-replay-codex-discover-repeat-"));
    const rolloutPath = join(dir, "rollout-2026-04-26T09-50-00-codex-session-repeat.jsonl");
    const content = [
      {
        timestamp: "2026-04-26T09:50:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session-repeat", cwd: "/Users/test/project", source: "app" },
      },
      {
        timestamp: "2026-04-26T09:50:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please run the same command." }],
        },
      },
      {
        timestamp: "2026-04-26T09:50:01.001Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Please run the same command." },
      },
      {
        timestamp: "2026-04-26T09:51:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Please run the same command." },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(rolloutPath, content);

    try {
      const info = await extractCodexSessionInfo(rolloutPath, Buffer.byteLength(content));

      expect(info).toMatchObject({
        sessionId: "codex-session-repeat",
        promptCount: 2,
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

  it("keeps the /resume title supplied by state metadata over JSONL updates", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:05:00.000Z",
          type: "event_msg",
          payload: { type: "thread_name_updated", thread_name: "Transcript title" },
        },
      ].map((line) => JSON.stringify(line)),
      {
        provider: "codex",
        sessionId: "codex-session-state-title",
        slug: "codex-session",
        title: "State database title",
        project: "/Users/test/project",
        cwd: "/Users/test/project",
        version: "0.1.0",
        timestamp: "2026-04-26T10:05:00.000Z",
        lineCount: 1,
        fileSize: 1,
        filePath: "/tmp/codex.jsonl",
        filePaths: ["/tmp/codex.jsonl"],
        firstPrompt: "Inspect the project",
      },
    );

    expect(result.title).toBe("State database title");
  });

  it("merges Codex web_search_call with matching web_search_end events", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:10:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-web", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:10:01.000Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            status: "completed",
            action: { type: "search", query: "Codex rollout schema" },
          },
        },
        {
          timestamp: "2026-04-26T10:10:01.100Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "ws_1",
            query: "Codex rollout schema",
            action: { query: "Codex rollout schema", type: "search" },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tools = result.turns.flatMap((turn) =>
      turn.blocks.filter((block) => block.type === "tool_use"),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "tool_use",
      name: "web_search",
      _result: "[Search: Codex rollout schema]",
    });
  });

  it("keeps Codex web_search_end events that omit query text", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:11:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-web-empty", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:11:01.000Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "ws_empty",
            query: "",
            action: { type: "open_page" },
          },
        },
        {
          timestamp: "2026-04-26T10:11:01.001Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            status: "completed",
            action: { type: "open_page" },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tools = result.turns.flatMap((turn) =>
      turn.blocks.filter((block) => block.type === "tool_use"),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "tool_use",
      name: "web_search",
      _result: "[Web search: open_page]",
    });
  });

  it("uses Codex patch_apply_end metadata to attribute edited files", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:20:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-patch", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:20:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "patch_1",
            input: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch",
          },
        },
        {
          timestamp: "2026-04-26T10:20:02.000Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "patch_1",
            status: "completed",
            success: true,
            changes: {
              "/Users/test/project/src/app.ts": { status: "modified" },
              "/Users/test/project/src/auth.ts": { status: "modified" },
            },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "Edit",
      input: {
        file_paths: ["/Users/test/project/src/app.ts", "/Users/test/project/src/auth.ts"],
      },
      _result: expect.stringContaining("Changed files:"),
    });
  });

  it("preserves changed files when patch_apply_end is the only patch event", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:21:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-orphan-patch", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:21:01.000Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "patch_orphan",
            status: "completed",
            success: true,
            changes: {
              "/Users/test/project/src/app.ts": { status: "modified" },
              "/Users/test/project/src/auth.ts": { status: "added" },
            },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "Edit",
      input: {
        file_paths: ["/Users/test/project/src/app.ts", "/Users/test/project/src/auth.ts"],
      },
    });
  });

  it("preserves multi-file apply_patch contents through replay transform", () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-export const enabled = false;
+export const enabled = true;
*** Add File: src/auth.ts
+export const auth = true;
*** End Patch`;
    const parsed = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:25:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-multi-patch", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-04-26T10:25:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "patch_multi",
            input: patch,
          },
        },
      ].map((line) => JSON.stringify(line)),
    );
    const replay = transformToReplay(parsed, "codex", "~/project");
    const scene = replay.scenes.find((item) => item.type === "tool-call");

    expect(scene?.type).toBe("tool-call");
    expect(scene?.type === "tool-call" && scene.diffs).toEqual([
      {
        filePath: "src/app.ts",
        oldContent: "export const enabled = false;",
        newContent: "export const enabled = true;",
      },
      {
        filePath: "src/auth.ts",
        oldContent: "",
        newContent: "export const auth = true;",
      },
    ]);
  });

  it("parses Codex developer messages as context injections", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:30:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-dev", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:30:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Use the repo testing instructions." }],
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turns[0]).toMatchObject({
      role: "user",
      subtype: "context-injection",
    });
    const replay = transformToReplay(result, "codex", "~/project");
    expect(replay.scenes[0]).toMatchObject({
      type: "context-injection",
      content: "Use the repo testing instructions.",
    });
    expect(replay.meta.stats.userPrompts).toBe(0);
  });

  it("reports context sizes without retaining Codex instruction content", () => {
    const baseInstructions = "Private base instructions";
    const developerContext = "Private developer context";
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:31:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-session-context-size",
            cwd: "/Users/test/project",
            base_instructions: { text: baseInstructions },
          },
        },
        {
          timestamp: "2026-04-26T10:31:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: developerContext }],
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.contextBreakdown).toEqual({
      source: "codex-rollout",
      scope: "session-metadata",
      components: [
        {
          id: "system-prompt",
          contentBytes: Buffer.byteLength(baseInstructions),
          itemCount: 1,
        },
        {
          id: "developer-context",
          contentBytes: Buffer.byteLength(developerContext),
          itemCount: 1,
        },
      ],
    });
    expect(JSON.stringify(result.contextBreakdown)).not.toContain("Private");
  });

  it("does not align task durations against Codex context injections", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:35:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-duration", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:35:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Use project rules." }],
          },
        },
        {
          timestamp: "2026-04-26T10:35:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Run the tests." },
        },
        {
          timestamp: "2026-04-26T10:35:05.000Z",
          type: "event_msg",
          payload: { type: "task_complete", duration_ms: 5000 },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turnStats).toHaveLength(1);
    expect(result.turnStats?.[0]).toMatchObject({ turnIndex: 0, durationMs: 5000 });
  });

  it("keeps timestamp fallback duration when Codex task_complete coverage is partial", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:36:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-partial-duration", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-04-26T10:36:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "First prompt." },
        },
        {
          timestamp: "2026-04-26T10:36:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", duration_ms: 1000 },
        },
        {
          timestamp: "2026-04-26T10:36:10.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Second prompt." },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turnStats).toHaveLength(2);
    expect(result.totalDurationMs).toBe(10_000);
  });

  it("tracks current Codex compaction events", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:40:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-compact", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:40:01.000Z",
          type: "event_msg",
          payload: { type: "context_compacted" },
        },
        {
          timestamp: "2026-04-26T10:40:02.000Z",
          type: "compacted",
          payload: { message: "", replacement_history: [] },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.compactions).toMatchObject([{ trigger: "codex-context" }]);
  });

  it("prefers the specific Codex context compaction trigger when duplicate events arrive", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-04-26T10:41:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-compact-order", cwd: "/Users/test/project", source: "cli" },
        },
        {
          timestamp: "2026-04-26T10:41:01.000Z",
          type: "compacted",
          payload: { message: "", replacement_history: [] },
        },
        {
          timestamp: "2026-04-26T10:41:02.000Z",
          type: "event_msg",
          payload: { type: "context_compacted" },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.compactions).toMatchObject([{ trigger: "codex-context" }]);
  });

  it("parses current Codex response-item user messages without duplicating event messages", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:31:26.394Z",
          type: "session_meta",
          payload: { id: "codex-session-7", cwd: "/Users/test/project", source: "codex-app" },
        },
        {
          timestamp: "2026-05-03T06:31:26.394Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>/Users/test/project</cwd>\n</environment_context>\n## My request for Codex: Address Codex compatibility gaps.",
              },
            ],
          },
        },
        {
          timestamp: "2026-05-03T06:31:26.396Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Address Codex compatibility gaps." },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const userTurns = result.turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].blocks[0]).toMatchObject({
      type: "text",
      text: "Address Codex compatibility gaps.",
    });
  });

  it("keeps repeated same-text Codex prompts after the dedupe window", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:35:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-repeat", cwd: "/Users/test/project", source: "codex-app" },
        },
        {
          timestamp: "2026-05-03T06:35:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Same prompt after a pause." },
        },
        {
          timestamp: "2026-05-03T06:36:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Same prompt after a pause." },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  });

  it("parses Codex agent messages and MCP tool end events", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:32:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-8", cwd: "/Users/test/project", source: "codex-app" },
        },
        {
          timestamp: "2026-05-03T06:32:01.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "I will inspect the recent PRs." },
        },
        {
          timestamp: "2026-05-03T06:32:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "_get_users_recent_prs_in_repo",
            call_id: "mcp_1",
            arguments: JSON.stringify({ repository_full_name: "tuo-lei/vibe-replay" }),
          },
        },
        {
          timestamp: "2026-05-03T06:32:03.000Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "mcp_1",
            invocation: {
              server: "codex_apps",
              tool: "github_get_users_recent_prs_in_repo",
              arguments: { repository_full_name: "tuo-lei/vibe-replay" },
            },
            duration: { secs: 1, nanos: 0 },
            result: { Ok: { content: [{ type: "text", text: "PR #231" }] } },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(result.turns.some((turn) => JSON.stringify(turn.blocks).includes("recent PRs"))).toBe(
      true,
    );
    expect(result.mcpServersUsed).toEqual(["codex_apps"]);
    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "mcp__codex_apps__github_get_users_recent_prs_in_repo",
      _result: "PR #231",
      _durationMs: 1000,
    });
  });

  it("marks failed Codex MCP tool end events as errors", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:40:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-session-mcp-error",
            cwd: "/Users/test/project",
            source: "codex-app",
          },
        },
        {
          timestamp: "2026-05-03T06:40:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "_get_users_recent_prs_in_repo",
            call_id: "mcp_error",
            arguments: JSON.stringify({ repository_full_name: "tuo-lei/vibe-replay" }),
          },
        },
        {
          timestamp: "2026-05-03T06:40:02.000Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "mcp_error",
            invocation: {
              server: "codex_apps",
              tool: "github_get_users_recent_prs_in_repo",
            },
            duration: { secs: 3, nanos: 0 },
            result: { Err: "rate limited" },
          },
        },
        {
          timestamp: "2026-05-03T06:40:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "mcp_error",
            output: JSON.stringify({ result: { Err: "rate limited" } }),
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      _isError: true,
      _result: "rate limited",
      _durationMs: 3000,
    });
  });

  it("retains an MCP invocation when only the end event is present", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:50:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-session-mcp-orphan",
            cwd: "/Users/test/project",
            source: "codex-app",
          },
        },
        {
          timestamp: "2026-05-03T06:50:01.000Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "mcp_orphan",
            invocation: {
              server: "codex_apps",
              tool: "github_search",
              arguments: { query: "vibe-replay" },
            },
            result: { Ok: { content: [{ type: "text", text: "one result" }] } },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(result.mcpServersUsed).toEqual(["codex_apps"]);
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "mcp__codex_apps__github_search",
      _result: "one result",
    });
  });

  it("keeps a serverless MCP completion in the MCP facet", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:55:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-mcp-unknown", cwd: "/Users/test/project" },
        },
        {
          timestamp: "2026-05-03T06:55:01.000Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "mcp_unknown",
            invocation: {},
            result: { Err: "server unavailable" },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      name: "mcp",
      _mcpServer: "Unknown",
      _hasResult: true,
      _isError: true,
    });
  });

  it("marks Codex MCP result.isError payloads as errors", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-05-03T06:45:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-session-mcp-result-error",
            cwd: "/Users/test/project",
            source: "codex-app",
          },
        },
        {
          timestamp: "2026-05-03T06:45:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "_get_users_recent_prs_in_repo",
            call_id: "mcp_result_error",
            arguments: JSON.stringify({ repository_full_name: "tuo-lei/vibe-replay" }),
          },
        },
        {
          timestamp: "2026-05-03T06:45:02.000Z",
          type: "event_msg",
          payload: {
            type: "mcp_tool_call_end",
            call_id: "mcp_result_error",
            invocation: {
              server: "codex_apps",
              tool: "github_get_users_recent_prs_in_repo",
            },
            result: {
              isError: true,
              content: [{ type: "text", text: "permission denied" }],
            },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    const tool = result.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use");
    expect(tool).toMatchObject({
      type: "tool_use",
      _isError: true,
      _result: "permission denied",
    });
  });
});

describe("Codex response item compatibility", () => {
  it("parses user content variants without aborting on non-object JSONL records", () => {
    const result = parseCodexLines(
      [
        {
          timestamp: "2026-08-24T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-response-variants", cwd: "/tmp/project" },
        },
        null,
        {
          timestamp: "2026-08-24T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "String content prompt",
          },
        },
        {
          timestamp: "2026-08-24T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: { text: "Object content prompt" },
          },
        },
      ].map((line) => JSON.stringify(line)),
    );

    expect(
      result.turns
        .filter((turn) => turn.role === "user")
        .map((turn) => turn.blocks.find((block) => block.type === "text")?.text),
    ).toEqual(["String content prompt", "Object content prompt"]);
  });
});
