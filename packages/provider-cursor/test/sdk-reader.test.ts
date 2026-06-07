import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __testables,
  applySdkEnrichmentToTurns,
  formatSdkToolResult,
  type SdkAgent,
  type SdkAgentEnrichment,
} from "../src/cursor/sdk-reader.js";
import type { ParsedTurn } from "@vibe-replay/provider-contract";

/**
 * Build a synthetic Cursor SDK index.db on disk that matches the real schema:
 *   agents      (agent_id, workspace_ref, status, name, ...)
 *   runs        (run_id, agent_id, turn_number, status, model, started_at, finished_at, result)
 *   run_events  (run_id, seq, event_type, payload_json, ...)
 *
 * Returns the file path so tests can pass it to readers.
 */
async function createSyntheticSdkIndexDb(
  dir: string,
  data: {
    agents: Array<{
      agent_id: string;
      workspace_ref: string;
      status?: string;
      name?: string;
      created_at?: string;
      updated_at?: string;
    }>;
    runs: Array<{
      run_id: string;
      agent_id: string;
      turn_number: number;
      status?: string;
      model?: string;
      started_at?: string;
      finished_at?: string;
      result?: string;
    }>;
    events: Array<{
      run_id: string;
      seq: number;
      payload: Record<string, any>;
    }>;
  },
): Promise<string> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      workspace_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      active_run_id TEXT,
      latest_checkpoint_ref_json TEXT,
      name TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      turn_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      model_params_json TEXT,
      start_checkpoint_ref_json TEXT,
      latest_checkpoint_ref_json TEXT,
      error_code TEXT,
      usage_ref TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      cancelled_at TEXT,
      expired_at TEXT,
      UNIQUE(agent_id, turn_number)
    )
  `);
  db.run(`
    CREATE TABLE run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      offset TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      payload_ref TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `);

  for (const a of data.agents) {
    db.run(
      `INSERT INTO agents (agent_id, workspace_ref, status, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        a.agent_id,
        a.workspace_ref,
        a.status ?? "IDLE",
        a.name ?? null,
        a.created_at ?? "2026-01-01T00:00:00.000Z",
        a.updated_at ?? "2026-01-01T00:00:01.000Z",
      ],
    );
  }
  for (const r of data.runs) {
    db.run(
      `INSERT INTO runs (run_id, agent_id, turn_number, status, model, started_at, finished_at, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.run_id,
        r.agent_id,
        r.turn_number,
        r.status ?? "FINISHED",
        r.model ?? null,
        r.started_at ?? null,
        r.finished_at ?? null,
        r.result ?? null,
        r.started_at ?? "2026-01-01T00:00:00.000Z",
        r.finished_at ?? "2026-01-01T00:00:01.000Z",
      ],
    );
  }
  for (const e of data.events) {
    db.run(
      `INSERT INTO run_events (run_id, seq, offset, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        e.run_id,
        e.seq,
        String(e.seq),
        "run_stream_event",
        JSON.stringify(e.payload),
        "2026-01-01T00:00:00.000Z",
      ],
    );
  }

  const bytes = db.export();
  const dbPath = join(dir, "index.db");
  await writeFile(dbPath, Buffer.from(bytes));
  db.close();
  return dbPath;
}

describe("formatSdkToolResult", () => {
  it("extracts stdout from shell tool results", () => {
    const formatted = formatSdkToolResult("Shell", {
      status: "success",
      value: { exitCode: 0, stdout: "hello world\n", stderr: "" },
    });
    expect(formatted.text).toBe("hello world");
    expect(formatted.isError).toBe(false);
  });

  it("flags non-zero exit codes as errors", () => {
    const formatted = formatSdkToolResult("Shell", {
      status: "success",
      value: { exitCode: 1, stdout: "", stderr: "boom" },
    });
    expect(formatted.text).toContain("[stderr]");
    expect(formatted.text).toContain("boom");
    expect(formatted.isError).toBe(true);
  });

  it("returns Read content verbatim", () => {
    const formatted = formatSdkToolResult("ReadFile", {
      status: "success",
      value: { content: "line1\nline2\n", totalLines: 2, fileSize: 12 },
    });
    expect(formatted.text).toBe("line1\nline2\n");
  });

  it("wraps Edit diff so downstream inferEditStringsFromResult picks it up", () => {
    const formatted = formatSdkToolResult("ApplyPatch", {
      status: "success",
      value: {
        linesAdded: 1,
        linesRemoved: 0,
        diffString: "@@ -1,1 +1,2 @@\n existing\n+new line",
      },
    });
    const parsed = JSON.parse(formatted.text);
    expect(parsed.diff.chunks[0].diffString).toBe("@@ -1,1 +1,2 @@\n existing\n+new line");
    expect(parsed.linesAdded).toBe(1);
  });

  it("falls back to JSON for unknown shapes", () => {
    const formatted = formatSdkToolResult("UnknownTool", {
      status: "success",
      value: { foo: "bar" },
    });
    expect(JSON.parse(formatted.text)).toEqual({ foo: "bar" });
    expect(formatted.isError).toBe(false);
  });

  it("treats string results as-is", () => {
    expect(formatSdkToolResult("Shell", "raw text").text).toBe("raw text");
  });

  it("returns empty string for null/undefined", () => {
    expect(formatSdkToolResult("Shell", null).text).toBe("");
    expect(formatSdkToolResult("Shell", undefined).text).toBe("");
  });
});

describe("collectToolCalls", () => {
  it("pairs running + completed events on the same call_id", () => {
    const rows = [
      {
        run_id: "r1",
        seq: 10,
        payload_json: JSON.stringify({
          message: {
            type: "tool_call",
            call_id: "call_a",
            name: "shell",
            status: "running",
            args: { command: "ls" },
          },
        }),
      },
      {
        run_id: "r1",
        seq: 11,
        payload_json: JSON.stringify({
          message: {
            type: "tool_call",
            call_id: "call_a",
            name: "shell",
            status: "completed",
            args: { command: "ls" },
            result: { status: "success", value: { exitCode: 0, stdout: "ok\n", stderr: "" } },
          },
        }),
      },
    ];
    const calls = __testables.collectToolCalls(rows);
    const r1 = calls.get("r1") ?? [];
    expect(r1).toHaveLength(1);
    expect(r1[0].callId).toBe("call_a");
    expect(r1[0].name).toBe("Bash"); // mapCursorToolName("shell")
    expect(r1[0].status).toBe("completed");
    expect(r1[0].result).toBe("ok");
    expect(r1[0].isError).toBe(false);
    expect(r1[0].firstSeq).toBe(10);
    expect(r1[0].lastSeq).toBe(11);
  });

  it("ignores non-tool_call events", () => {
    const rows = [
      {
        run_id: "r1",
        seq: 1,
        payload_json: JSON.stringify({ message: { type: "thinking", text: "..." } }),
      },
      {
        run_id: "r1",
        seq: 2,
        payload_json: JSON.stringify({ message: { type: "assistant", message: { content: [] } } }),
      },
    ];
    expect(__testables.collectToolCalls(rows).size).toBe(0);
  });

  it("keeps latest non-empty args even when key count does not change", () => {
    const rows = [
      {
        run_id: "r1",
        seq: 1,
        payload_json: JSON.stringify({
          message: {
            type: "tool_call",
            call_id: "call_a",
            name: "shell",
            status: "running",
            args: { command: "echo partial" },
          },
        }),
      },
      {
        run_id: "r1",
        seq: 2,
        payload_json: JSON.stringify({
          message: {
            type: "tool_call",
            call_id: "call_a",
            name: "shell",
            status: "completed",
            args: { command: "echo full command" },
            result: { status: "success", value: { exitCode: 0, stdout: "ok\n", stderr: "" } },
          },
        }),
      },
    ];
    const list = __testables.collectToolCalls(rows).get("r1") ?? [];
    expect(list[0].args).toEqual({ command: "echo full command" });
  });

  it("does not synthesize an empty result from running-only events", () => {
    const rows = [
      {
        run_id: "r1",
        seq: 1,
        payload_json: JSON.stringify({
          message: {
            type: "tool_call",
            call_id: "call_running",
            name: "shell",
            status: "running",
            args: { command: "sleep 10" },
          },
        }),
      },
    ];
    const list = __testables.collectToolCalls(rows).get("r1") ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("running");
    expect(list[0].result).toBeUndefined();
  });

  it("preserves intra-run ordering by firstSeq", () => {
    const rows = [
      {
        run_id: "r1",
        seq: 5,
        payload_json: JSON.stringify({
          message: { type: "tool_call", call_id: "b", name: "edit", status: "running", args: {} },
        }),
      },
      {
        run_id: "r1",
        seq: 3,
        payload_json: JSON.stringify({
          message: { type: "tool_call", call_id: "a", name: "read", status: "running", args: {} },
        }),
      },
    ];
    const list = __testables.collectToolCalls(rows).get("r1") ?? [];
    expect(list.map((c) => c.callId)).toEqual(["a", "b"]);
  });
});

describe("applySdkEnrichmentToTurns", () => {
  function makeEnrichment(): SdkAgentEnrichment {
    const agent: SdkAgent = {
      agentId: "agent-x",
      workspaceRef: "/tmp/ws",
      status: "IDLE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:30.000Z",
      dbPath: "/tmp/ws/sdk/index.db",
    };
    return {
      agent,
      runs: [
        {
          runId: "r1",
          agentId: "agent-x",
          turnNumber: 1,
          status: "FINISHED",
          model: "composer-2",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:05.000Z",
        },
        {
          runId: "r2",
          agentId: "agent-x",
          turnNumber: 2,
          status: "FINISHED",
          model: "composer-2",
          startedAt: "2026-01-01T00:00:10.000Z",
          finishedAt: "2026-01-01T00:00:15.000Z",
        },
      ],
      toolCallsByRun: new Map([
        [
          "r1",
          [
            {
              callId: "c1",
              runId: "r1",
              firstSeq: 1,
              lastSeq: 2,
              name: "Bash",
              args: { command: "ls" },
              status: "completed",
              result: "file1\nfile2",
              isError: false,
            },
          ],
        ],
        [
          "r2",
          [
            {
              callId: "c2",
              runId: "r2",
              firstSeq: 3,
              lastSeq: 4,
              name: "Read",
              args: { file_path: "/tmp/x.txt" },
              status: "completed",
              result: "contents",
              isError: false,
            },
          ],
        ],
      ]),
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:15.000Z",
      totalDurationMs: 10000,
      latestModel: "composer-2",
    };
  }

  it("attaches results to JSONL tool_use blocks in turn order", () => {
    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "first prompt" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "j1", name: "Bash", input: { command: "ls" } }],
      },
      { role: "user", blocks: [{ type: "text", text: "second prompt" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "j2", name: "Read", input: { file_path: "/tmp/x.txt" } }],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    expect(result.toolCallsEnriched).toBe(2);
    expect(result.assistantTurnsModelTagged).toBe(2);

    const a1 = turns[1].blocks[0];
    expect(a1.type).toBe("tool_use");
    if (a1.type !== "tool_use") throw new Error("type narrow");
    expect(a1._result).toBe("file1\nfile2");

    const a2 = turns[3].blocks[0];
    if (a2.type !== "tool_use") throw new Error("type narrow");
    expect(a2._result).toBe("contents");
    expect(turns[1].model).toBe("composer-2");
    expect(turns[3].model).toBe("composer-2");
  });

  it("does not overwrite an existing _result", () => {
    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "prompt" }] },
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "j1",
            name: "Bash",
            input: { command: "ls" },
            _result: "preexisting",
          },
        ],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    expect(result.toolCallsEnriched).toBe(0);
    const block = turns[1].blocks[0];
    if (block.type !== "tool_use") throw new Error("type narrow");
    expect(block._result).toBe("preexisting");
  });

  it("does not consume SDK call slots for already-resolved tool blocks", () => {
    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "prompt" }] },
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "already-resolved",
            name: "ToolOutput",
            input: {},
            _result: "preexisting sidecar result",
          },
          { type: "tool_use", id: "needs-sdk", name: "Bash", input: { command: "ls" } },
        ],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    expect(result.toolCallsEnriched).toBe(1);
    const blocks = turns[1].blocks;
    if (blocks[0].type !== "tool_use" || blocks[1].type !== "tool_use") throw new Error("narrow");
    expect(blocks[0]._result).toBe("preexisting sidecar result");
    expect(blocks[1]._result).toBe("file1\nfile2");
  });

  it("treats empty-string _result blocks as already resolved", () => {
    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "prompt" }] },
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            id: "empty-result",
            name: "Bash",
            input: { command: "true" },
            _result: "",
          },
          { type: "tool_use", id: "needs-sdk", name: "Bash", input: { command: "ls" } },
        ],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    expect(result.toolCallsEnriched).toBe(1);
    const blocks = turns[1].blocks;
    if (blocks[0].type !== "tool_use" || blocks[1].type !== "tool_use") throw new Error("narrow");
    expect(blocks[0]._result).toBe("");
    expect(blocks[1]._result).toBe("file1\nfile2");
  });

  it("does not enrich running-only SDK calls as empty results", () => {
    const enrichment = makeEnrichment();
    const calls = enrichment.toolCallsByRun.get("r1") ?? [];
    calls[0] = {
      ...calls[0],
      status: "running",
      result: undefined,
    };

    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "prompt" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "j1", name: "Bash", input: { command: "sleep 10" } }],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, enrichment);
    expect(result.toolCallsEnriched).toBe(0);
    const block = turns[1].blocks[0];
    if (block.type !== "tool_use") throw new Error("type narrow");
    expect(block._result).toBeUndefined();
  });

  it("handles JSONL having more tool_use blocks than SDK calls", () => {
    const turns: ParsedTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "p1" }] },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    // Only one SDK call in run r1 → first block enriched, second untouched.
    expect(result.toolCallsEnriched).toBe(1);
    const blocks = turns[1].blocks;
    if (blocks[0].type !== "tool_use" || blocks[1].type !== "tool_use") throw new Error("narrow");
    expect(blocks[0]._result).toBe("file1\nfile2");
    expect(blocks[1]._result).toBeUndefined();
  });

  it("ignores assistant text that appears before any user prompt", () => {
    const turns: ParsedTurn[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "stray", name: "Bash", input: {} }],
      },
      { role: "user", blocks: [{ type: "text", text: "p1" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "j1", name: "Bash", input: {} }],
      },
    ];
    const result = applySdkEnrichmentToTurns(turns, makeEnrichment());
    expect(result.toolCallsEnriched).toBe(1);
    const stray = turns[0].blocks[0];
    if (stray.type !== "tool_use") throw new Error("narrow");
    expect(stray._result).toBeUndefined();
  });
});

describe("loadSdkAgentEnrichment + listSdkIndexDbPaths (integration with synthetic db)", () => {
  let tempRoot: string;
  let dbPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "vibe-replay-sdk-"));
    const projectDir = join(
      tempRoot,
      ".cursor",
      "projects",
      "Users-tlei-fixture-ws",
      "sdk-agent-store",
      "abc123",
    );
    await mkdir(projectDir, { recursive: true });
    dbPath = await createSyntheticSdkIndexDb(projectDir, {
      agents: [
        {
          agent_id: "agent-fixture-1",
          workspace_ref: "/Users/tlei/fixture/ws",
          status: "IDLE",
          name: "fixture-agent",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:01:00.000Z",
        },
      ],
      runs: [
        {
          run_id: "run-fixture-r1",
          agent_id: "agent-fixture-1",
          turn_number: 1,
          status: "FINISHED",
          model: "composer-2",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:30.000Z",
          result: "done",
        },
      ],
      events: [
        {
          run_id: "run-fixture-r1",
          seq: 1,
          payload: {
            schemaVersion: 1,
            type: "sdk_message",
            message: {
              type: "tool_call",
              call_id: "call_synthetic_1",
              name: "shell",
              status: "running",
              args: { command: "echo hi" },
            },
          },
        },
        {
          run_id: "run-fixture-r1",
          seq: 2,
          payload: {
            schemaVersion: 1,
            type: "sdk_message",
            message: {
              type: "tool_call",
              call_id: "call_synthetic_1",
              name: "shell",
              status: "completed",
              args: { command: "echo hi" },
              result: { status: "success", value: { exitCode: 0, stdout: "hi\n", stderr: "" } },
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("listSdkIndexDbPaths walks sdk-agent-store/<hash>/index.db files", async () => {
    const paths = await __testables.listSdkIndexDbPaths(join(tempRoot, ".cursor", "projects"));
    expect(paths).toContain(dbPath);
  });

  it("loadSdkAgentEnrichment reconstructs runs and tool calls", async () => {
    const { loadSdkAgentEnrichment } = await import("../src/cursor/sdk-reader.js");
    const enrichment = await loadSdkAgentEnrichment({
      agentId: "agent-fixture-1",
      workspaceRef: "/Users/tlei/fixture/ws",
      status: "IDLE",
      name: "fixture-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      dbPath,
    });
    expect(enrichment).not.toBeNull();
    if (!enrichment) throw new Error("guard");
    expect(enrichment.runs).toHaveLength(1);
    expect(enrichment.runs[0].runId).toBe("run-fixture-r1");
    expect(enrichment.runs[0].model).toBe("composer-2");
    expect(enrichment.latestModel).toBe("composer-2");
    expect(enrichment.totalDurationMs).toBe(29000);

    const calls = enrichment.toolCallsByRun.get("run-fixture-r1") ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("Bash");
    expect(calls[0].result).toBe("hi");
    expect(calls[0].status).toBe("completed");
  });
});
