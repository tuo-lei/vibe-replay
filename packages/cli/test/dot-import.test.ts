import { buildUsageCoverageReport } from "../src/usage-coverage.js";
import { parseDotExport } from "@vibe-replay/provider-dot";
import { transformToReplay } from "../src/transform.js";
import { hasReplayableContent } from "../src/server-core.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanSession } from "../src/scanner.js";
import { getProvider } from "../src/providers/index.js";

it("registers dot and scans only conversation data without claiming usage coverage", async () => {
  expect(getProvider("dot")?.displayName).toBe("dot (conversation import)");
  const directory = await mkdtemp(join(tmpdir(), "dot-scan-"));
  try {
    const path = join(directory, "export.json");
    await writeFile(
      path,
      JSON.stringify({
        before: [
          {
            message_id: "synthetic-user",
            channel: "chatgpt",
            author: "user",
            content: { text: "Please make a replay" },
            sent_at: "2026-10-04T01:00:00Z",
          },
        ],
        message: {
          message_id: "synthetic-assistant",
          channel: "chatgpt",
          author: "aeon",
          content: { text: "Here is the result." },
          sent_at: "2026-10-04T02:00:00Z",
        },
        after: [],
        partial: true,
      }),
    );
    const scan = await scanSession({
      provider: "dot",
      sessionId: "dot-synthetic",
      slug: "dot-synthetic",
      project: "dot conversations",
      filePaths: [path],
    });
    expect(scan.promptCount).toBe(1);
    expect(scan.dataSource).toBe("json");
    expect(scan.usageIndexed).toBe(false);
    expect(scan.usageSummary).toBeUndefined();
    expect(scan.tokenUsage).toBeUndefined();
    expect(scan.durationMs).toBeUndefined();
    expect(scan.startTime).toBe("2026-10-04T01:00:00.000Z");
    expect(scan.dataQualityNotes).toContain(
      "The source marks this conversation window as partial.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("allows a visible assistant-only dot window without relaxing native trace eligibility", () => {
  const parsed = parseDotExport({
    before: [],
    message: {
      message_id: "assistant-only",
      channel: "chatgpt",
      author: "aeon",
      content: { text: "A proactive visible update." },
    },
    after: [],
    partial: false,
  });
  const replay = transformToReplay(parsed, "dot", "dot conversations");
  expect(hasReplayableContent(replay)).toBe(true);
  expect(hasReplayableContent({ ...replay, meta: { ...replay.meta, provider: "codex" } })).toBe(
    false,
  );
  expect(hasReplayableContent({ ...replay, scenes: [] })).toBe(false);
});

it("reports dot execution metrics as unavailable, not partially observed", () => {
  const report = buildUsageCoverageReport([
    {
      sessionId: "dot",
      provider: "dot",
      project: "dot conversations",
      slug: "dot",
      promptCount: 0,
      toolCallCount: 0,
      editCount: 0,
      filesModified: [],
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 0,
      usageIndexed: false,
    },
  ]);
  const metrics = report.providers[0].metrics;
  expect(metrics.invocations).toEqual({
    availableSessions: 0,
    totalSessions: 1,
    quality: "unavailable",
  });
  expect(metrics.compactions).toEqual({
    availableSessions: 0,
    totalSessions: 1,
    quality: "unavailable",
  });
  expect(metrics.tokens.quality).toBe("unavailable");
  expect(metrics.cache.quality).toBe("unavailable");
  expect(metrics.mcpTools.quality).toBe("unavailable");
});
