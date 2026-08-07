import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformToReplay } from "./helpers/transform.js";
import { createCursorParser, parseCursorSession } from "../src/cursor/parser.js";
import {
  isSystemContextText,
  mapCursorToolName,
  mapToolArgs,
} from "../src/cursor/sqlite-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeNestedSession(
  parentBlocks: Array<Record<string, unknown>>,
  subagentLines: Array<Record<string, unknown> | string>,
  agentId = "subagent-123",
): Promise<{ transcript: string; agentId: string }> {
  const root = await mkdtemp(join(tmpdir(), "cursor-subagent-test-"));
  tempDirs.push(root);
  const sessionId = "session-123";
  const sessionDir = join(root, "agent-transcripts", sessionId);
  const subagentsDir = join(sessionDir, "subagents");
  await mkdir(subagentsDir, { recursive: true });

  const transcript = join(sessionDir, `${sessionId}.jsonl`);
  const parentLines = [
    {
      role: "user",
      message: { content: [{ type: "text", text: "Investigate the parser" }] },
    },
    { role: "assistant", message: { content: parentBlocks } },
  ];
  await writeFile(transcript, `${parentLines.map(JSON.stringify).join("\n")}\n`, "utf-8");
  await writeFile(
    join(subagentsDir, `${agentId}.jsonl`),
    `${subagentLines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
    "utf-8",
  );
  return { transcript, agentId };
}

function delegationBlock(prompt: string): Record<string, unknown> {
  return {
    type: "tool_use",
    name: "Subagent",
    input: {
      description: "Inspect parser behavior",
      prompt,
      subagent_type: "explore",
      model: "composer-2.5",
    },
  };
}

describe("Cursor subagent transcript ingestion", () => {
  it("links a sibling transcript by prompt and exposes its complete replay scenes", async () => {
    const prompt = "Find the parser and verify how file edits are represented.";
    const { transcript, agentId } = await writeNestedSession(
      [delegationBlock(prompt)],
      [
        {
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: `You are a delegated worker. Complete this task:\n\n${prompt}`,
              },
            ],
          },
        },
        {
          role: "assistant",
          timestamp: "2026-08-06T12:00:00.000Z",
          message: {
            content: [
              { type: "text", text: "I found the parser and checked the edit path." },
              { type: "reasoning", text: "Compare both formats before reporting." },
              {
                type: "tool_use",
                id: "read-1",
                name: "ReadFile",
                input: { path: "/repo/parser.ts" },
              },
              {
                type: "tool_use",
                name: "EditFile",
                input: {
                  path: "/repo/parser.ts",
                  oldStr: "const oldValue = true;",
                  newStr: "const newValue = true;",
                },
              },
            ],
          },
        },
        {
          role: "user",
          timestamp: "2026-08-06T12:00:01.000Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: [{ type: "text", text: "export const parser = true;" }],
              },
            ],
          },
        },
        { type: "turn_ended", status: "success" },
      ],
      "a87ea5db-926f-43b0-81bd-589f48ee2e4d",
    );

    const parsed = await parseCursorSession(transcript);
    const agentBlock = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "Agent");

    expect(agentBlock?.type === "tool_use" && agentBlock._subAgent).toMatchObject({
      agentId,
      agentType: "Explore",
      description: "Inspect parser behavior",
      prompt,
      model: "composer-2.5",
      toolCalls: 2,
      thinkingBlocks: 1,
      textResponses: 1,
    });
    expect(agentBlock?.type === "tool_use" && agentBlock._subAgent?.scenes).toEqual([
      {
        type: "text-response",
        content: "I found the parser and checked the edit path.",
        timestamp: "2026-08-06T12:00:00.000Z",
      },
      {
        type: "thinking",
        content: "Compare both formats before reporting.",
        timestamp: "2026-08-06T12:00:00.000Z",
      },
      {
        type: "tool-call",
        toolName: "Read",
        input: { file_path: "/repo/parser.ts" },
        result: "export const parser = true;",
        timestamp: "2026-08-06T12:00:00.000Z",
        isError: false,
        durationMs: 1000,
      },
      {
        type: "tool-call",
        toolName: "Edit",
        input: {
          file_path: "/repo/parser.ts",
          old_string: "const oldValue = true;",
          new_string: "const newValue = true;",
        },
        result: "",
        timestamp: "2026-08-06T12:00:00.000Z",
        isError: false,
      },
    ]);
    expect(parsed.subAgentSummary).toEqual([
      {
        agentId,
        agentType: "Explore",
        description: "Inspect parser behavior",
        toolCalls: 2,
        model: "composer-2.5",
      },
    ]);
    expect(parsed.dataSourceInfo?.supplements).toContain(
      "cursor subagent transcripts (1/1 linked, 2 tool calls)",
    );

    const replay = transformToReplay(parsed, "cursor", "~/test");
    const replayAgent = replay.scenes.find(
      (scene) => scene.type === "tool-call" && scene.toolName === "Agent",
    );
    expect(replayAgent?.type === "tool-call" && replayAgent.subAgent?.toolCalls).toBe(2);
    expect(
      replayAgent?.type === "tool-call" &&
        replayAgent.subAgent?.scenes.find(
          (scene) => scene.type === "tool-call" && scene.toolName === "Edit",
        ),
    ).toMatchObject({
      diff: {
        filePath: "/repo/parser.ts",
        oldContent: "const oldValue = true;",
        newContent: "const newValue = true;",
      },
    });
  });

  it("enriches SQLite-primary sessions from the sibling JSONL transcript", async () => {
    const prompt = "Inspect the auth middleware.";
    const { transcript, agentId } = await writeNestedSession(
      [delegationBlock(prompt)],
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: `Delegated task:\n${prompt}` }] },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "ReadFile", input: { path: "/repo/auth.ts" } }],
          },
        },
      ],
    );
    const parseCursorSqlite = vi.fn().mockResolvedValue({
      sessionId: "session-123",
      slug: "session-",
      cwd: "/repo",
      turns: [
        { role: "user", blocks: [{ type: "text", text: "Inspect the parser" }] },
        {
          role: "assistant",
          blocks: [
            {
              type: "tool_use",
              id: "sqlite-task-1",
              name: "Agent",
              input: {
                description: "Inspect auth",
                prompt,
                subagent_type: "explore",
              },
            },
          ],
        },
      ],
      dataSource: "sqlite",
      dataSourceInfo: { primary: "sqlite", sources: ["cursor/store.db"] },
    });
    const parser = createCursorParser({
      isSystemContextText,
      mapCursorToolName,
      mapToolArgs,
      parseCursorSqlite,
    });

    const parsed = await parser(transcript, {
      provider: "cursor",
      sessionId: "session-123",
      slug: "session-",
      project: "/repo",
      cwd: "/repo",
      version: "",
      timestamp: "2026-08-06T12:00:00.000Z",
      lineCount: 2,
      fileSize: 1,
      filePath: transcript,
      filePaths: [transcript],
      firstPrompt: "Inspect the parser",
    });
    const agent = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "Agent");

    expect(parsed.dataSource).toBe("sqlite");
    expect(agent?.type === "tool_use" && agent._subAgent?.agentId).toBe(agentId);
    expect(agent?.type === "tool_use" && agent._subAgent?.toolCalls).toBe(1);
  });

  it("does not guess when a subagent prompt cannot be linked", async () => {
    const { transcript } = await writeNestedSession(
      [delegationBlock("Inspect the parser")],
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "A completely unrelated task" }] },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "ReadFile", input: { path: "/repo/x.ts" } }],
          },
        },
      ],
    );

    const parsed = await parseCursorSession(transcript);
    const agent = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "Agent");
    expect(agent?.type === "tool_use" && agent._subAgent).toBeUndefined();
    expect(parsed.subAgentSummary).toBeUndefined();
  });

  it("keeps unmatched delegations in the summary when only some transcripts can link", async () => {
    const linkedPrompt = "Inspect the parser";
    const { transcript, agentId } = await writeNestedSession(
      [delegationBlock(linkedPrompt), delegationBlock("Inspect the missing worker")],
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: `Delegated task: ${linkedPrompt}` }] },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "ReadFile", input: { path: "/repo/x.ts" } }],
          },
        },
      ],
    );

    const parsed = await parseCursorSession(transcript);
    expect(parsed.subAgentSummary).toHaveLength(2);
    expect(parsed.subAgentSummary?.[0]).toMatchObject({ agentId, toolCalls: 1 });
    expect(parsed.subAgentSummary?.[1]).toMatchObject({ toolCalls: 0 });

    const replay = transformToReplay(parsed, "cursor", "~/test");
    expect(replay.meta.subAgentSummary).toHaveLength(2);
  });

  it("assigns exact prompt matches before weaker containment matches", async () => {
    const shortPrompt = "Inspect parser";
    const exactPrompt = "Inspect parser deeply";
    const broadAgentId = "broad-agent";
    const exactAgentId = "exact-agent";
    const { transcript } = await writeNestedSession(
      [delegationBlock(shortPrompt), delegationBlock(exactPrompt)],
      [
        {
          role: "user",
          message: {
            content: [{ type: "text", text: `Delegated task: ${exactPrompt} and tests` }],
          },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Broad containment result" }] },
        },
      ],
      broadAgentId,
    );
    const subagentsDir = join(dirname(transcript), "subagents");
    const exactPath = join(subagentsDir, `${exactAgentId}.jsonl`);
    await writeFile(
      exactPath,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: exactPrompt }] },
      })}\n${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Exact result" }] },
      })}\n`,
      "utf-8",
    );
    await utimes(join(subagentsDir, `${broadAgentId}.jsonl`), new Date(1_000), new Date(1_000));
    await utimes(exactPath, new Date(2_000), new Date(2_000));

    const parsed = await parseCursorSession(transcript);
    const agentBlocks = parsed.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "tool_use" && block.name === "Agent");
    const shortBlock = agentBlocks.find(
      (block) => block.type === "tool_use" && block.input.prompt === shortPrompt,
    );
    const exactBlock = agentBlocks.find(
      (block) => block.type === "tool_use" && block.input.prompt === exactPrompt,
    );

    expect(shortBlock?.type === "tool_use" && shortBlock._subAgent?.agentId).toBe(broadAgentId);
    expect(exactBlock?.type === "tool_use" && exactBlock._subAgent?.agentId).toBe(exactAgentId);
  });

  it("skips progress records in subagent transcripts", async () => {
    const prompt = "Inspect progress handling.";
    const { transcript } = await writeNestedSession(
      [delegationBlock(prompt)],
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: `Delegated task: ${prompt}` }] },
        },
        {
          type: "progress",
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "ReadFile", input: { path: "/repo/streamed.ts" } }],
          },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "ReadFile", input: { path: "/repo/real.ts" } }],
          },
        },
      ],
    );

    const parsed = await parseCursorSession(transcript);
    const agent = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "Agent");
    expect(agent?.type === "tool_use" && agent._subAgent?.toolCalls).toBe(1);
    expect(agent?.type === "tool_use" && agent._subAgent?.scenes).toEqual([
      expect.objectContaining({ type: "tool-call", input: { file_path: "/repo/real.ts" } }),
    ]);
  });

  it("keeps all scenes for large subagent transcripts instead of silently capping them", async () => {
    const prompt = "Read every generated file.";
    const tools = Array.from({ length: 500 }, (_, index) => ({
      type: "tool_use",
      name: "ReadFile",
      input: { path: `/repo/generated-${index}.ts` },
    }));
    const { transcript } = await writeNestedSession(
      [delegationBlock(prompt)],
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: `Delegated task: ${prompt}` }] },
        },
        { role: "assistant", message: { content: tools } },
      ],
    );

    const parsed = await parseCursorSession(transcript);
    const agent = parsed.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "tool_use" && block.name === "Agent");
    expect(agent?.type === "tool_use" && agent._subAgent?.toolCalls).toBe(500);
    expect(agent?.type === "tool_use" && agent._subAgent?.scenes).toHaveLength(500);
  });

  it("reports malformed lines without dropping the rest of the subagent transcript", async () => {
    const prompt = "Inspect malformed input handling.";
    const { transcript } = await writeNestedSession(
      [delegationBlock(prompt)],
      [
        "{not-json",
        {
          role: "user",
          message: { content: [{ type: "text", text: `Delegated task: ${prompt}` }] },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "The remaining data is valid." }] },
        },
      ],
    );

    const parsed = await parseCursorSession(transcript);
    expect(parsed.parseWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "malformed-json",
          source: "cursor subagent transcript JSONL",
          firstLine: 1,
        }),
      ]),
    );
    expect(parsed.subAgentSummary?.[0]?.toolCalls).toBe(0);
  });
});
