import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanSession } from "../src/scanner.js";
import { scanResultToInsight } from "../src/insights.js";

it("indexes nested Codex tools and both patch paths without counting the wrapper or attributing automation to a human turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-scan-accounting-"));
  try {
    const path = join(root, "rollout.jsonl");
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+new\n*** End Patch";
    const records = [
      { type: "session_meta", payload: { id: "scan-accounting", cwd: root } },
      { type: "turn_context", payload: { model: "gpt-5.4" } },
      { type: "event_msg", payload: { type: "user_message", message: "Update both source files" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "batch",
          input: `text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.mcp__devspace__read({path:"src/a.ts"}));`,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "batch",
          output: "Script completed\nOutput:\n{}\n{}",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "<heartbeat><instructions>Check status</instructions></heartbeat>",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "automatic-check",
          arguments: JSON.stringify({ cmd: "git status" }),
        },
      },
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
    const scan = await scanSession({
      provider: "codex",
      sessionId: "scan-accounting",
      slug: "scan-accounting",
      project: root,
      filePaths: [path],
    });
    expect(scan).toMatchObject({
      promptCount: 1,
      automationTriggerCount: 1,
      toolCallCount: 3,
      editCount: 1,
    });
    expect(scan.filesModified).toEqual([
      { file: "src/a.ts", count: 1 },
      { file: "src/b.ts", count: 1 },
    ]);
    expect(scan.usageSummary).toMatchObject({
      tools: { Edit: 1, Bash: 1 },
      mcpServers: { devspace: 1 },
      mcpTools: { "devspace/read": 1 },
      successCount: 0,
      errorCount: 0,
    });
    expect(scan.turnMetrics).toEqual([{ toolCalls: 2 }]);
    expect(scanResultToInsight(scan).automationTriggerCount).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
