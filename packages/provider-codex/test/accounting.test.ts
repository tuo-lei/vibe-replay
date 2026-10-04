import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { describe, expect, it } from "vitest";
import { extractCodexSessionInfo, mergeCodexSessionMetadata } from "../src/codex/discover.js";
import { nestedExecTools } from "../src/codex/exec-tools.js";
import { parseCodexLines } from "../src/codex/parser.js";
import { transformToReplay } from "./helpers/transform.js";

const message = (text: string) => ({
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});
const context = (model: string) => ({ type: "turn_context", payload: { model } });
const usage = (input: number, cached: number, output: number) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      },
      last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 },
    },
  },
});
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record));
const heartbeat =
  "<heartbeat><automation_id>review</automation_id><instructions>Check the current PR.</instructions></heartbeat>";
const patch =
  "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch";
const script = `text(await tools.apply_patch(${JSON.stringify(patch)}));\ntext(await tools.mcp__devspace__read({workspace_id: "work", path: "src/a.ts"}));`;
const batch = (source = script, result = "Script completed\nOutput:\nbatch output") => [
  {
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", call_id: "batch", input: source },
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "batch",
      output: [{ type: "input_text", text: result }],
    },
  },
];

describe("Codex host accounting", () => {
  it("keeps heartbeat context visible while discovery and replay count only human interventions", async () => {
    const records = encode([
      { type: "session_meta", payload: { id: "host-accounting", cwd: "/tmp/project" } },
      message("# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>Use pnpm.</INSTRUCTIONS>"),
      message('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
      message("# Files mentioned by the user:\n## My request: Fix the layout"),
      message(heartbeat),
      message("Now check the screenshots"),
    ]);
    const parsed = parseCodexLines(records);
    const replay = transformToReplay(parsed, "codex");
    expect(replay.meta.stats.userPrompts).toBe(2);
    expect(replay.meta.stats.automationTriggerCount).toBe(1);
    expect(replay.scenes.filter((scene) => scene.type === "user-prompt")).toMatchObject([
      { content: "Fix the layout" },
      { content: "Now check the screenshots" },
    ]);
    expect(replay.scenes).toContainEqual(
      expect.objectContaining({
        type: "context-injection",
        injectionType: "automation",
        content: heartbeat,
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "codex-host-accounting-"));
    try {
      const path = join(root, "rollout.jsonl");
      await writeFile(path, records.join("\n"));
      const discovered = await extractCodexSessionInfo(path, (await stat(path)).size);
      expect(discovered).toMatchObject({
        promptCount: 2,
        automationTriggerCount: 1,
        firstPrompt: "Fix the layout",
      });
      expect(discovered?.prompts).toEqual(["Fix the layout", "Now check the screenshots"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows automation-only transcripts to replay instead of classifying them as no-prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-auto-only-"));
    try {
      const path = join(root, "rollout.jsonl");
      await writeFile(
        path,
        encode([{ type: "session_meta", payload: { id: "automatic" } }, message(heartbeat)]).join(
          "\n",
        ),
      );
      const discovered = await extractCodexSessionInfo(path, (await stat(path)).size);
      expect(discovered).toMatchObject({ promptCount: 0, automationTriggerCount: 1 });
      expect(discovered?.transcriptStatus).toBeUndefined();
      expect(
        mergeCodexSessionMetadata(discovered!, {
          sessionId: "automatic",
          firstUserMessage: heartbeat,
        }).firstPrompt,
      ).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the batch output and attributes nested edits/MCP once without inventing child success", () => {
    const parsed = parseCodexLines(encode([message("Update the source files"), ...batch()]));
    const blocks = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      name: "exec",
      _isToolContainer: true,
      _result: "Script completed\nOutput:\nbatch output",
      _hasResult: true,
    });
    expect(blocks[1]).toMatchObject({
      name: "Edit",
      input: { file_paths: ["src/a.ts", "src/b.ts"] },
      _hasResult: false,
    });
    expect(blocks[2]).toMatchObject({ name: "mcp__devspace__read", _hasResult: false });
    expect(parsed.mcpServersUsed).toEqual(["devspace"]);
    const replay = transformToReplay(parsed, "codex");
    expect(replay.meta.stats.toolCalls).toBe(2);
    expect(replay.scenes.filter((scene) => scene.type === "tool-call")).toHaveLength(3);
  });

  it.each([
    'if (false) await tools.apply_patch("patch");',
    "for (const path of paths) await tools.exec_command({cmd: path});",
    'const unused = () => tools.apply_patch("patch");',
    'tools.apply_patch("patch");',
    'let cmd = "old"; cmd = "new"; await tools.exec_command({cmd});',
    'const input = {cmd:"old"}; input.cmd = "new"; await tools.exec_command(input);',
    'exit(); await tools.apply_patch("patch");',
    'tools.apply_patch = fake; await tools.apply_patch("patch");',
  ])("leaves unsupported exec control flow opaque: %s", (source) => {
    expect(nestedExecTools(source, "Script completed\nOutput:")).toBeUndefined();
    const parsed = parseCodexLines(encode(batch(source)));
    expect(
      parsed.turns.flatMap((turn) => turn.blocks).filter((block) => block.type === "tool_use"),
    ).toMatchObject([{ name: "exec", _hasResult: true }]);
  });

  it.each([
    'const run = tools.exec_command; await run({cmd:"check"});',
    'const {exec_command: run} = tools; await run({cmd:"check"});',
    'const alias = tools; await alias.exec_command({cmd:"check"});',
    'await tools.exec_command.call(null, {cmd:"check"});',
    'const run = tools["exec_command"].bind(tools); await run({cmd:"check"});',
  ])("keeps mixed aliased and direct calls opaque: %s", (aliasedCall) => {
    const source = `${aliasedCall} await tools.apply_patch("patch");`;
    expect(nestedExecTools(source, "Script completed\nOutput:")).toBeUndefined();
    const parsed = parseCodexLines(encode(batch(source)));
    expect(
      parsed.turns.flatMap((turn) => turn.blocks).filter((block) => block.type === "tool_use"),
    ).toMatchObject([{ name: "exec", _hasResult: true }]);
  });

  it("does not mistake a literal tools property for an aliased tool reference", () => {
    expect(
      nestedExecTools('await tools.exec_command({tools:"literal"});', "Script completed"),
    ).toEqual([{ name: "exec_command", input: { tools: "literal" } }]);
  });

  it("reads literal parallel calls without executing JavaScript or scraping tool names from strings", () => {
    const source =
      'const cmd = "tools.apply_patch(fake)"; globalThis.__vibeExecParserExecuted = true; const results = await Promise.allSettled([tools.exec_command({cmd}), tools.mcp__test__read({path:"src/a.ts"})]); results.forEach(text);';
    expect(nestedExecTools(source, "Script completed\nOutput:")).toEqual([
      { name: "exec_command", input: { cmd: "tools.apply_patch(fake)" } },
      { name: "mcp__test__read", input: { path: "src/a.ts" } },
    ]);
    expect((globalThis as Record<string, unknown>).__vibeExecParserExecuted).toBeUndefined();
    expect(nestedExecTools(source, "Script running with cell ID 1")).toBeUndefined();
    expect(nestedExecTools(source, "Script failed\nOutput:")).toBeUndefined();
  });

  it("attributes cumulative deltas to the actual model and prompt, keeping automation billing separate", () => {
    const parsed = parseCodexLines(
      encode([
        context("model-a"),
        message("First human request"),
        usage(100, 20, 10),
        usage(100, 20, 10),
        usage(160, 40, 20),
        message(heartbeat),
        context("model-b"),
        usage(200, 50, 30),
        message("Second human request"),
        usage(300, 90, 50),
      ]),
    );
    expect(parsed.model).toBe("model-b");
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 210,
      cacheReadTokens: 90,
      outputTokens: 50,
      cacheCreationTokens: 0,
    });
    expect(parsed.tokenUsageByModel).toEqual({
      "model-a": {
        inputTokens: 120,
        cacheReadTokens: 40,
        outputTokens: 20,
        cacheCreationTokens: 0,
      },
      "model-b": { inputTokens: 90, cacheReadTokens: 50, outputTokens: 30, cacheCreationTokens: 0 },
    });
    expect(parsed.turnStats).toMatchObject([
      {
        turnIndex: 0,
        model: "model-a",
        tokenUsage: { inputTokens: 120, cacheReadTokens: 40, outputTokens: 20 },
      },
      {
        turnIndex: 1,
        model: "model-b",
        tokenUsage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 20 },
      },
    ]);
  });

  it("marks reset counters unknown instead of billing the latest model for earlier work", () => {
    const parsed = parseCodexLines(
      encode([
        context("gpt-5.4"),
        message("Before resume"),
        usage(100, 20, 10),
        context("gpt-5.4-mini"),
        message("After resume"),
        usage(50, 10, 5),
      ]),
    );
    expect(parsed.tokenUsageByModel).toEqual({ unknown: parsed.tokenUsage });
    expect(transformToReplay(parsed, "codex").meta.stats.costEstimate).toBeUndefined();
    expect(parsed.dataSourceInfo?.notes?.join(" ")).toContain("counters reset");
  });

  it("retains known model deltas after a reset, with aggregate totals conserved", () => {
    const parsed = parseCodexLines(
      encode([
        context("model-a"),
        message("Before resume"),
        usage(100, 20, 10),
        message("After resume"),
        usage(50, 10, 5),
        context("model-b"),
        usage(150, 40, 15),
      ]),
    );
    expect(parsed.tokenUsageByModel).toEqual({
      unknown: { inputTokens: 40, cacheReadTokens: 10, outputTokens: 5, cacheCreationTokens: 0 },
      "model-b": { inputTokens: 70, cacheReadTokens: 30, outputTokens: 10, cacheCreationTokens: 0 },
    });
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 110,
      cacheReadTokens: 40,
      outputTokens: 15,
      cacheCreationTokens: 0,
    });
  });

  it("classifies native scheduled-task headers separately from human prompts", () => {
    const parsed = parseCodexLines(
      encode([message("Automation: docs sync\nAutomation ID: docs-sync\nCheck the README.")]),
    );
    const replay = transformToReplay(parsed, "codex");
    expect(replay.meta.stats.userPrompts).toBe(0);
    expect(replay.meta.stats.automationTriggerCount).toBe(1);
  });

  it.each([6, 100])("handles small and large replays with %i batches", (count) => {
    const records = [
      context("gpt-5.4"),
      ...Array.from({ length: count }, (_, i) => [
        message(`Human request ${i}`),
        message(heartbeat),
        ...batch(script.replaceAll("batch", `batch-${i}`)),
      ]).flat(),
    ];
    // Give each persisted call its own ID as a real rollout does.
    let call = 0;
    for (const [index, record] of records.entries()) {
      Object.assign(record, {
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, index * 3)).toISOString(),
      });
      const payload = record.payload as Record<string, unknown>;
      if (payload.type === "custom_tool_call") payload.call_id = `batch-${call}`;
      if (payload.type === "custom_tool_call_output") payload.call_id = `batch-${call++}`;
    }
    const replay = transformToReplay(parseCodexLines(encode(records)), "codex");
    expect(replay.meta.stats.userPrompts).toBe(count);
    expect(replay.meta.stats.toolCalls).toBe(count * 2);
    expect(replay.meta.stats.automationTriggerCount).toBe(count);
    expect(replay.scenes.length).toBe(count * 5);
  });
});

describe("Codex wrapped triggers and chronological accounting", () => {
  it.each(["## My request:", "## My request for Codex:"])(
    "retains a human prompt quoting a request prefix and automation payload: %s",
    async (prefix) => {
      const text = `Document this example without changing it:\n${prefix}\nAutomation: Audit\nAutomation ID: audit\nCheck results`;
      const records = encode([
        { type: "session_meta", payload: { id: "quoted-request", cwd: "/tmp/project" } },
        message(text),
      ]);
      const replay = transformToReplay(parseCodexLines(records), "codex");
      expect(replay.meta.stats.userPrompts).toBe(1);
      expect(replay.meta.stats.automationTriggerCount).toBe(0);
      expect(replay.scenes).toMatchObject([{ type: "user-prompt", content: text }]);
      const root = await mkdtemp(join(tmpdir(), "codex-quoted-request-"));
      try {
        const path = join(root, "rollout.jsonl");
        await writeFile(path, records.join("\n"));
        expect(await extractCodexSessionInfo(path, (await stat(path)).size)).toMatchObject({
          promptCount: 1,
          automationTriggerCount: 0,
          firstPrompt: text.replaceAll("\n", " "),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([100, 160])(
    "does not treat an automation snapshot at %s as a final bill for later work",
    (autoInput) => {
      const parsed = parseCodexLines(
        encode([
          context("model-a"),
          message("First request"),
          usage(100, 20, 10),
          message(heartbeat),
          context("model-auto"),
          usage(autoInput, 20, 10),
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Later automatic work" }],
            },
          },
          message("Second request"),
          context("model-b"),
          usage(300, 60, 30),
          usage(300, 60, 30),
        ]),
      );
      expect(parsed.turnStats?.[1]?.tokenUsage).toBeUndefined();
      expect(parsed.tokenUsageByModel?.unknown).toEqual({
        inputTokens: 260 - autoInput,
        cacheReadTokens: 40,
        outputTokens: 20,
        cacheCreationTokens: 0,
      });
      expect(parsed.tokenUsage).toEqual({
        inputTokens: 240,
        cacheReadTokens: 60,
        outputTokens: 30,
        cacheCreationTokens: 0,
      });
    },
  );

  it.each([heartbeat, "Automation: Audit\nAutomation ID: audit\nCheck results"])(
    "deduplicates normalized paired automation records and retains a later trigger: %s",
    async (trigger) => {
      const records = encode([
        { type: "session_meta", payload: { id: "paired-triggers", cwd: "/tmp/project" } },
        {
          ...message(`## My request:\n<environment_context>host</environment_context>\n${trigger}`),
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          type: "event_msg",
          timestamp: "2026-01-01T00:00:01Z",
          payload: { type: "user_message", message: trigger },
        },
        { ...message(trigger), timestamp: "2026-01-01T00:00:05Z" },
      ]);
      const replay = transformToReplay(parseCodexLines(records), "codex");
      expect(replay.meta.stats.userPrompts).toBe(0);
      expect(replay.meta.stats.automationTriggerCount).toBe(2);
      const root = await mkdtemp(join(tmpdir(), "codex-paired-trigger-"));
      try {
        const path = join(root, "rollout.jsonl");
        await writeFile(path, records.join("\n"));
        expect(await extractCodexSessionInfo(path, (await stat(path)).size)).toMatchObject({
          promptCount: 0,
          automationTriggerCount: 2,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("leaves a delta spanning unreported automation unattributed, then resumes human/model accounting", () => {
    const parsed = parseCodexLines(
      encode([
        context("model-a"),
        message("First request"),
        usage(100, 20, 10),
        message(heartbeat),
        context("model-auto"),
        message("Second request"),
        context("model-b"),
        usage(300, 90, 50),
        usage(350, 100, 60),
      ]),
    );
    expect(parsed.turnStats).toMatchObject([
      { turnIndex: 0, tokenUsage: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10 } },
      { turnIndex: 1, tokenUsage: { inputTokens: 40, cacheReadTokens: 10, outputTokens: 10 } },
    ]);
    expect(parsed.tokenUsageByModel).toEqual({
      "model-a": { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10, cacheCreationTokens: 0 },
      unknown: { inputTokens: 130, cacheReadTokens: 70, outputTokens: 40, cacheCreationTokens: 0 },
      "model-b": { inputTokens: 40, cacheReadTokens: 10, outputTokens: 10, cacheCreationTokens: 0 },
    });
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 250,
      cacheReadTokens: 100,
      outputTokens: 60,
      cacheCreationTokens: 0,
    });
    expect(parsed.dataSourceInfo?.notes?.join(" ")).toContain(
      "automation interval with no usage snapshot",
    );
  });

  it("omits human billing when its only cumulative delta spans unreported automation", () => {
    const parsed = parseCodexLines(
      encode([
        context("model-a"),
        message(heartbeat),
        message("Human request"),
        usage(100, 20, 10),
      ]),
    );
    expect(parsed.turnStats?.[0]?.tokenUsage).toBeUndefined();
    expect(parsed.tokenUsageByModel).toEqual({ unknown: parsed.tokenUsage });
  });

  it.each([
    "## My request for Codex:",
    "## My request:",
    "# Files mentioned by the user:\n## My request for Codex:",
    "<environment_context>host</environment_context>\n# Files mentioned by the user:\n## My request:\n<app-context>host</app-context>",
  ])("classifies request-prefixed triggers in both record formats: %s", async (prefix) => {
    for (const format of ["response_item", "event_msg"]) {
      const records = encode([
        { type: "session_meta", payload: { id: "request-prefixed-trigger", cwd: "/tmp/project" } },
        ...[
          heartbeat,
          "Automation: Audit\nAutomation ID: audit\nCheck results",
          "Human request",
        ].map((text) => {
          const wrapped = `${prefix}\n${text}`;
          return format === "event_msg"
            ? { type: "event_msg", payload: { type: "user_message", message: wrapped } }
            : message(wrapped);
        }),
        message(
          "# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>Example: ## My request: human text</INSTRUCTIONS>",
        ),
      ]);
      const parsed = parseCodexLines(records);
      expect(parsed.turns.map((turn) => turn.subtype)).toEqual([
        "automation-trigger",
        "automation-trigger",
        undefined,
        "context-injection",
      ]);
      const replay = transformToReplay(parsed, "codex");
      expect(replay.meta.stats.userPrompts).toBe(1);
      expect(replay.meta.stats.automationTriggerCount).toBe(2);
      expect(replay.scenes.filter((scene) => scene.type === "user-prompt")).toMatchObject([
        { content: "Human request" },
      ]);
      const root = await mkdtemp(join(tmpdir(), "codex-request-trigger-"));
      try {
        const path = join(root, "rollout.jsonl");
        await writeFile(path, records.join("\n"));
        const info = await extractCodexSessionInfo(path, (await stat(path)).size);
        expect(info).toMatchObject({
          promptCount: 1,
          automationTriggerCount: 2,
          firstPrompt: "Human request",
        });
        expect(info?.prompts).toEqual(["Human request"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it.each(["response_item", "event_msg"])(
    "classifies wrapped host messages in %s records",
    async (format) => {
      const wrap = (text: string) =>
        `<environment_context>cwd=/tmp/project</environment_context>\n<app-context>host</app-context>\n${text}`;
      const msgs = [
        wrap(heartbeat),
        wrap("Automation: Audit\nAutomation ID: audit\nCheck results"),
        wrap("# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>Use pnpm</INSTRUCTIONS>"),
        "Human request",
      ];
      const records = encode([
        { type: "session_meta", payload: { id: "wrapped-triggers", cwd: "/tmp/project" } },
        ...msgs.map((text) =>
          format === "event_msg"
            ? { type: "event_msg", payload: { type: "user_message", message: text } }
            : message(text),
        ),
      ]);
      const parsed = parseCodexLines(records);
      expect(parsed.turns.map((turn) => turn.subtype)).toEqual([
        "automation-trigger",
        "automation-trigger",
        "context-injection",
        undefined,
      ]);
      expect(transformToReplay(parsed, "codex").meta.stats.userPrompts).toBe(1);
      const root = await mkdtemp(join(tmpdir(), "codex-wrapped-trigger-"));
      try {
        const path = join(root, "rollout.jsonl");
        await writeFile(path, records.join("\n"));
        const info = await extractCodexSessionInfo(path, (await stat(path)).size);
        expect(info).toMatchObject({
          promptCount: 1,
          automationTriggerCount: 2,
          firstPrompt: "Human request",
        });
        expect(info?.prompts).toEqual(["Human request"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not attribute earlier tokens or tools to a model learned by discovery later", () => {
    const parsed = parseCodexLines(
      encode([
        message("First request"),
        usage(100, 20, 10),
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "early",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        },
        context("later-model"),
        usage(150, 30, 15),
      ]),
      { model: "later-model" } as SessionInfo,
    );
    expect(parsed.tokenUsageByModel).toEqual({
      unknown: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10, cacheCreationTokens: 0 },
      "later-model": {
        inputTokens: 40,
        cacheReadTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
      },
    });
    expect(
      parsed.turns.find((turn) => turn.blocks.some((block) => block.type === "tool_use"))?.model,
    ).toBeUndefined();
    expect(parsed.model).toBe("later-model");
    expect(
      parseCodexLines(encode([message("No recorded model")]), {
        model: "discovery-only",
      } as SessionInfo).model,
    ).toBe("discovery-only");
  });

  const timed = (record: object, seconds: number) => ({
    ...record,
    timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + seconds * 1000).toISOString(),
  });
  const completed = (duration_ms: number) => ({
    type: "event_msg",
    payload: { type: "task_complete", duration_ms },
  });
  it("uses complete provider durations for automation-only transcripts", () => {
    const parsed = parseCodexLines(
      encode([timed(message(heartbeat), 0), timed(completed(1200), 50)]),
    );
    expect(parsed.totalDurationMs).toBe(1200);
    expect(parsed.turnStats).toBeUndefined();
  });
  it("requires a completion in every trigger interval, not merely enough completions", () => {
    const parsed = parseCodexLines(
      encode([
        timed(message(heartbeat), 0),
        timed(completed(1000), 1),
        timed(completed(2000), 2),
        timed(message("Human request with no completion"), 10),
        timed(
          { type: "event_msg", payload: { type: "agent_message", message: "Still working" } },
          20,
        ),
      ]),
    );
    expect(parsed.totalDurationMs).toBe(20000);
  });
  it("sums complete human and automation intervals without orphan completions", () => {
    const parsed = parseCodexLines(
      encode([
        timed(completed(900000), 0),
        timed(message(heartbeat), 1),
        timed(completed(1000), 5),
        timed(message("Human request"), 10),
        timed(completed(2000), 20),
      ]),
    );
    expect(parsed.totalDurationMs).toBe(3000);
    expect(parsed.turnStats).toMatchObject([{ durationMs: 2000 }]);
  });
});
