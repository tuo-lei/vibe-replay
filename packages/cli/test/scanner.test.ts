import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  type SessionScanResult,
  scanSession,
} from "../src/scanner.js";

// ─── Helpers ──────────────────────────────────────────────────────

function makeLine(obj: Record<string, any>): string {
  return JSON.stringify(obj);
}

let tmpDir: string;
let fixturePath: string;
const CURSOR_FIXTURE = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-session.jsonl",
);
const CURSOR_TOOL_FIXTURE_1 = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-tool-1.txt",
);
const CURSOR_TOOL_FIXTURE_2 = join(
  import.meta.dirname,
  "../../provider-cursor/test/fixtures/cursor-tool-2.txt",
);
const COWORK_FIXTURE = join(
  import.meta.dirname,
  "../../provider-claude-code/test/fixtures/claude-cowork-audit.jsonl",
);

beforeAll(async () => {
  tmpDir = join(tmpdir(), `scanner-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // Create a test JSONL file with various message types
  const lines = [
    // file-history-snapshot (start marker)
    makeLine({
      type: "file-history-snapshot",
      sessionId: "test-session-1",
      slug: "test-slug",
      cwd: "/Users/test/Code/my-project",
      gitBranch: "main",
      permissionMode: "default",
      entrypoint: "cli",
      snapshot: { timestamp: "2025-03-20T10:00:00Z", trackedFileBackups: {} },
    }),
    // User prompt
    makeLine({
      type: "user",
      sessionId: "test-session-1",
      slug: "test-slug",
      cwd: "/Users/test/Code/my-project",
      gitBranch: "main",
      timestamp: "2025-03-20T10:00:01Z",
      message: {
        role: "user",
        id: "msg-u1",
        content: "Help me fix the login bug in auth.ts",
      },
    }),
    // Assistant with tool_use (Edit)
    makeLine({
      type: "assistant",
      sessionId: "test-session-1",
      gitBranch: "feat/fix-auth",
      timestamp: "2025-03-20T10:00:05Z",
      message: {
        role: "assistant",
        id: "msg-a1",
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "thinking", thinking: "Let me look at the auth code..." },
          { type: "text", text: "I'll fix the login bug." },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Edit",
            input: {
              file_path: "/Users/test/Code/my-project/src/auth.ts",
              old_string: "foo",
              new_string: "bar",
            },
          },
          {
            type: "tool_use",
            id: "tu-2",
            name: "Read",
            input: { file_path: "/Users/test/Code/my-project/src/utils.ts" },
          },
        ],
        usage: {
          input_tokens: 5000,
          output_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 4500,
        },
      },
    }),
    // User with tool results
    makeLine({
      type: "user",
      timestamp: "2025-03-20T10:00:10Z",
      message: {
        role: "user",
        id: "msg-u2",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "Edit applied" },
          { type: "tool_result", tool_use_id: "tu-2", content: "file content..." },
        ],
      },
    }),
    // Another user prompt
    makeLine({
      type: "user",
      timestamp: "2025-03-20T10:01:00Z",
      message: {
        role: "user",
        id: "msg-u3",
        content: "Now run the tests",
      },
    }),
    // PR link
    makeLine({
      type: "pr-link",
      timestamp: "2025-03-20T10:02:00Z",
      data: {
        prNumber: 42,
        prUrl: "https://github.com/test/my-project/pull/42",
        prRepository: "test/my-project",
      },
    }),
    // System events
    makeLine({
      type: "system",
      subtype: "turn_duration",
      timestamp: "2025-03-20T10:00:10Z",
      durationMs: 9000,
    }),
    makeLine({
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2025-03-20T10:01:30Z",
      compactMetadata: { trigger: "auto", preTokens: 150000 },
    }),
    makeLine({
      type: "system",
      subtype: "api_error",
      timestamp: "2025-03-20T10:01:15Z",
      error: { status: 529, error: { type: "overloaded_error" } },
    }),
    // Custom title
    makeLine({
      type: "custom-title",
      customTitle: "Fix login bug in auth module",
    }),
  ];

  fixturePath = join(tmpDir, "test-session.jsonl");
  await writeFile(fixturePath, lines.join("\n"), "utf-8");
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Scanner tests ──────────────────────────────────────────────────

describe("scanSession", () => {
  it("extracts session metadata correctly", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.sessionId).toBe("test-session-1");
    expect(result.provider).toBe("claude-code");
    expect(result.title).toBe("Fix login bug in auth module");
    expect(result.startTime).toBe("2025-03-20T10:00:00Z");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("counts prompts correctly (excludes tool_result-only turns)", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    // 2 user prompts: "Help me fix..." and "Now run the tests"
    // The tool_result-only message should NOT be counted
    expect(result.promptCount).toBe(2);
  });

  it("excludes Claude system wrappers and tool-originated text while keeping short prompts", async () => {
    const path = join(tmpDir, "claude-prompt-filtering.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "user",
          message: {
            role: "user",
            content: "<local-command-caveat>ignore me</local-command-caveat>",
          },
        }),
        makeLine({
          type: "user",
          isCompactSummary: true,
          message: {
            role: "user",
            content: "This session is being continued from a previous conversation summary",
          },
        }),
        makeLine({
          type: "user",
          sourceToolUseID: "tool-1",
          message: { role: "user", content: [{ type: "text", text: "automated result" }] },
        }),
        makeLine({
          type: "user",
          parent_tool_use_id: "tool-2",
          message: { role: "user", content: "automated string result" },
        }),
        makeLine({ type: "user", message: { role: "user", content: "Fix it" } }),
        makeLine({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "image", source: { type: "base64", data: "abc" } }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "prompt-filtering",
      provider: "claude-code",
      project: "~/test/project",
      slug: "prompt-filtering",
      filePaths: [path],
    });
    expect(result.promptCount).toBe(2);
  });

  it("uses the Cowork parser so replay duplicates do not inflate prompt analytics", async () => {
    const result = await scanSession({
      sessionId: "cowork-session-002",
      provider: "claude-cowork",
      project: "Cowork",
      slug: "cowork-s",
      filePaths: [COWORK_FIXTURE],
      timestamp: "2025-06-15T09:00:00.000Z",
      title: "Cowork fixture",
      firstPrompt: "Please investigate Cowork storage",
      discoveryModel: "claude-opus-4-6",
    });
    expect(result.promptCount).toBe(1);
    expect(result.toolCallCount).toBe(1);
  });

  it("counts tool calls and edits", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.toolCallCount).toBe(2); // Edit + Read
    expect(result.editCount).toBe(1); // Only Edit
    // The path starts with /Users/test/ which won't match homedir(), so it stays absolute
    expect(result.filesModified).toContainEqual({
      file: "/Users/test/Code/my-project/src/auth.ts",
      count: 1,
    });
  });

  it("extracts git branch history", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    // Branch switched from main → feat/fix-auth
    expect(result.gitBranch).toBe("feat/fix-auth");
    expect(result.gitBranches).toEqual(["main", "feat/fix-auth"]);
  });

  it("extracts PR links", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.prLinks).toHaveLength(1);
    expect(result.prLinks![0].prNumber).toBe(42);
  });

  it("extracts system events (compactions, API errors, duration)", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.compactionCount).toBe(1);
    expect(result.apiErrorCount).toBe(1);
    expect(result.durationMs).toBe(9000);
  });

  it("counts synthetic assistant API error messages", async () => {
    const path = join(tmpDir, "api-error-message.jsonl");
    await writeFile(
      path,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:00Z",
          isApiErrorMessage: true,
          message: {
            role: "assistant",
            id: "msg-api-error",
            content: [{ type: "text", text: "API Error: Claude's response failed." }],
          },
        }),
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:01Z",
          isApiErrorMessage: false,
          message: {
            role: "assistant",
            id: "msg-no-response",
            content: [{ type: "text", text: "No response requested." }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "test-session-api-error-message",
      provider: "claude-code",
      project: "~/project",
      slug: "api-error-message",
      filePaths: [path],
    });

    expect(result.apiErrorCount).toBe(1);
  });

  it("extracts token usage and cost", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.inputTokens).toBe(5000);
    expect(result.tokenUsage!.outputTokens).toBe(1000);
    expect(result.costEstimate).toBeGreaterThan(0);
  });

  it("keeps tokens but omits fabricated cost for an unknown model", async () => {
    const path = join(tmpDir, "unknown-model-session.jsonl");
    await writeFile(
      path,
      makeLine({
        type: "assistant",
        timestamp: "2025-03-20T10:00:05Z",
        message: {
          role: "assistant",
          id: "unknown-model-message",
          model: "local-model",
          content: [{ type: "text", text: "Done" }],
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "unknown-model-session",
      provider: "claude-code",
      project: "~/project",
      slug: "unknown-model",
      filePaths: [path],
    });

    expect(result.tokenUsage?.inputTokens).toBe(1000);
    expect(result.costEstimate).toBeUndefined();
    expect(result.dataQualityNotes).toContain(
      "Cost estimate is unavailable because model pricing or attribution is unknown.",
    );
  });

  it("extracts entrypoint and permissionMode", async () => {
    const result = await scanSession({
      sessionId: "test-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "test-slug",
      filePaths: [fixturePath],
    });

    expect(result.entrypoint).toBe("cli");
    expect(result.permissionMode).toBe("default");
  });

  it("counts Delete tool calls as modified files", async () => {
    const deleteFixturePath = join(tmpDir, "delete-session.jsonl");
    await writeFile(
      deleteFixturePath,
      [
        makeLine({
          type: "assistant",
          timestamp: "2025-03-20T10:00:05Z",
          message: {
            role: "assistant",
            id: "msg-a-delete",
            content: [
              {
                type: "tool_use",
                id: "tu-delete",
                name: "Delete",
                input: {
                  file_path: "/Users/test/Code/my-project/src/obsolete.ts",
                },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "delete-session-1",
      provider: "claude-code",
      project: "~/Code/my-project",
      slug: "delete-session",
      filePaths: [deleteFixturePath],
    });

    expect(result.toolCallCount).toBe(1);
    expect(result.editCount).toBe(1);
    expect(result.filesModified).toContainEqual({
      file: "/Users/test/Code/my-project/src/obsolete.ts",
      count: 1,
    });
  });

  it("uses the Cursor parser so tool-backed sessions contribute to stats", async () => {
    const result = await scanSession({
      sessionId: "cursor-session",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-s",
      filePaths: [CURSOR_FIXTURE],
      toolPaths: [CURSOR_TOOL_FIXTURE_1, CURSOR_TOOL_FIXTURE_2],
      timestamp: "2026-03-20T10:00:00.000Z",
    });

    expect(result.promptCount).toBe(3);
    expect(result.toolCallCount).toBe(2);
    expect(result.startTime).toBe("2026-03-20T10:00:00.000Z");
    expect(result.filesModified).toEqual([]);
  });

  it("excludes Codex developer context injections from prompt analytics", async () => {
    const codexFixturePath = join(tmpDir, "codex-context-session.jsonl");
    await writeFile(
      codexFixturePath,
      [
        makeLine({
          timestamp: "2026-04-26T10:30:00.000Z",
          type: "session_meta",
          payload: { id: "codex-context-session", cwd: "/Users/test/project", source: "cli" },
        }),
        makeLine({
          timestamp: "2026-04-26T10:30:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Use the repo testing instructions." }],
          },
        }),
        makeLine({
          timestamp: "2026-04-26T10:30:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Run the tests." },
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await scanSession({
      sessionId: "codex-context-session",
      provider: "codex",
      project: "~/test/project",
      slug: "codex-context",
      filePaths: [codexFixturePath],
      timestamp: "2026-04-26T10:30:00.000Z",
    });

    expect(result.promptCount).toBe(1);
    expect(result.firstPrompt).toBe("Run the tests.");
  });

  it("defers rich Cursor SQLite parsing for background scans", async () => {
    const result = await scanSession({
      sessionId: "cursor-sqlite-session",
      provider: "cursor",
      project: "~/test/project",
      slug: "cursor-sqlite",
      filePaths: [join(tmpDir, "missing-cursor-transcript.jsonl")],
      sourceFilePath:
        "/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb#composerData:cursor-sqlite-session",
      sourceFileSize: 2048,
      sourceLineCount: 9,
      hasSqlite: true,
      deferRichCursorParse: true,
      timestamp: "2026-03-20T10:00:00.000Z",
      title: "Cursor SQLite session",
      firstPrompt: "Build the dashboard.",
    });

    expect(result.promptCount).toBe(5);
    expect(result.toolCallCount).toBe(0);
    expect(result.dataSource).toBe("global-state");
    expect(result.dataQualityNotes?.[0]).toContain("deferred");
  });
});

// ─── Aggregation tests ──────────────────────────────────────────────

describe("aggregateProjectInsights", () => {
  const scans: SessionScanResult[] = [
    {
      sessionId: "s1",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-1",
      startTime: "2025-03-18T10:00:00Z",
      durationMs: 60000,
      model: "claude-sonnet-4-20250514",
      promptCount: 10,
      toolCallCount: 20,
      editCount: 5,
      filesModified: [
        { file: "src/a.ts", count: 2 },
        { file: "src/b.ts", count: 3 },
      ],
      costEstimate: 1.5,
      subAgentCount: 2,
      apiErrorCount: 1,
      compactionCount: 0,
      gitBranch: "feat/auth",
      gitBranches: ["main", "feat/auth"],
      prLinks: [{ prNumber: 1, prUrl: "https://github.com/t/p/pull/1", prRepository: "t/p" }],
    },
    {
      sessionId: "s2",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-2",
      startTime: "2025-03-19T10:00:00Z",
      durationMs: 30000,
      model: "claude-sonnet-4-20250514",
      promptCount: 5,
      toolCallCount: 10,
      editCount: 3,
      filesModified: [
        { file: "src/a.ts", count: 1 },
        { file: "src/c.ts", count: 2 },
      ],
      costEstimate: 0.8,
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 1,
      gitBranch: "feat/auth",
    },
    {
      sessionId: "s3",
      provider: "claude-code",
      project: "~/Code/proj-b",
      slug: "slug-3",
      startTime: "2025-03-20T10:00:00Z",
      durationMs: 45000,
      model: "claude-opus-4-20250514",
      promptCount: 8,
      toolCallCount: 15,
      editCount: 4,
      filesModified: [{ file: "src/x.ts", count: 4 }],
      costEstimate: 5.0,
      subAgentCount: 1,
      apiErrorCount: 0,
      compactionCount: 0,
      gitBranch: "main",
    },
  ];

  it("aggregates stats for a specific project", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    expect(insights.sessionCount).toBe(2);
    expect(insights.totalPrompts).toBe(15);
    expect(insights.totalToolCalls).toBe(30);
    expect(insights.totalEdits).toBe(8);
    expect(insights.totalCost).toBeCloseTo(2.3);
    expect(insights.totalDurationMs).toBe(90000);
    expect(insights.subAgentTotal).toBe(2);
    expect(insights.apiErrorTotal).toBe(1);
  });

  it("groups branches with session IDs", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    const authBranch = insights.branches.find((b) => b.branch === "feat/auth");
    expect(authBranch).toBeDefined();
    expect(authBranch!.sessionIds).toContain("s1");
    expect(authBranch!.sessionIds).toContain("s2");
    expect(authBranch!.prLinks).toHaveLength(1);
  });

  it("identifies hot files across sessions", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    const aFile = insights.hotFiles.find((f) => f.file === "src/a.ts");
    expect(aFile).toBeDefined();
    expect(aFile!.sessionCount).toBe(2); // Appeared in both s1 and s2
  });

  it("counts sessions per day", () => {
    const insights = aggregateProjectInsights("~/Code/proj-a", scans);

    expect(insights.sessionsPerDay["2025-03-18"]).toBe(1);
    expect(insights.sessionsPerDay["2025-03-19"]).toBe(1);
  });
});

describe("aggregateUserInsights", () => {
  const scans: SessionScanResult[] = [
    {
      sessionId: "s1",
      provider: "claude-code",
      project: "~/Code/proj-a",
      slug: "slug-1",
      startTime: "2025-03-18T10:00:00Z",
      durationMs: 60000,
      model: "claude-sonnet-4-20250514",
      promptCount: 10,
      toolCallCount: 20,
      editCount: 5,
      filesModified: [],
      costEstimate: 1.5,
      subAgentCount: 2,
      apiErrorCount: 1,
      compactionCount: 0,
    },
    {
      sessionId: "s2",
      provider: "cursor",
      project: "~/Code/proj-b",
      slug: "slug-2",
      startTime: "2025-03-19T10:00:00Z",
      durationMs: 30000,
      model: "claude-sonnet-4-20250514",
      promptCount: 5,
      toolCallCount: 10,
      editCount: 3,
      filesModified: [],
      costEstimate: 0.8,
      subAgentCount: 0,
      apiErrorCount: 0,
      compactionCount: 1,
    },
  ];

  it("aggregates across all projects", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.totalSessions).toBe(2);
    expect(insights.totalProjects).toBe(2);
    expect(insights.totalPrompts).toBe(15);
    expect(insights.totalToolCalls).toBe(30);
    expect(insights.totalCost).toBeCloseTo(2.3);
  });

  it("tracks provider distribution", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.providers["claude-code"]).toBe(1);
    expect(insights.providers.cursor).toBe(1);
  });

  it("ranks top projects by session count", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.topProjects).toHaveLength(2);
    expect(insights.topProjects[0].sessions).toBe(1);
  });

  it("calculates average session duration", () => {
    const insights = aggregateUserInsights(scans);

    expect(insights.avgSessionDurationMs).toBe(45000); // (60000 + 30000) / 2
  });

  it("marks Cursor aggregates as partial when metrics are missing or estimated", () => {
    const insights = aggregateUserInsights([
      {
        sessionId: "cursor-1",
        provider: "cursor",
        project: "~/Code/proj-cursor",
        slug: "cursor-1",
        startTime: "2025-03-19T10:00:00Z",
        durationMs: 30000,
        promptCount: 5,
        toolCallCount: 10,
        editCount: 1,
        filesModified: [],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
        dataQualityNotes: ["Duration is estimated from session start/end timestamps."],
      },
      {
        sessionId: "cursor-2",
        provider: "cursor",
        project: "~/Code/proj-cursor",
        slug: "cursor-2",
        startTime: "2025-03-20T10:00:00Z",
        promptCount: 2,
        toolCallCount: 3,
        editCount: 0,
        filesModified: [],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
    ]);

    expect(insights.dataQuality?.notes).toContain(
      "1/2 Cursor sessions use best-effort duration estimates.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "1/2 Cursor sessions do not have enough timing data to compute duration.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "2/2 Cursor sessions do not include token snapshots, so token and cost totals are partial.",
    );
    expect(insights.dataQuality?.notes).toContain(
      "2/2 Cursor sessions do not include per-turn stats.",
    );
  });

  it("aggregates token totals and turn duration histogram percentiles", () => {
    const insights = aggregateUserInsights([
      {
        sessionId: "s1",
        provider: "claude-code",
        project: "~/Code/proj-a",
        slug: "slug-1",
        startTime: "2025-03-18T10:00:00Z",
        durationMs: 60_000,
        promptCount: 1,
        toolCallCount: 2,
        editCount: 0,
        filesModified: [],
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheCreationTokens: 10,
        },
        turnDurations: [10_000, 45_000],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
      {
        sessionId: "s2",
        provider: "claude-code",
        project: "~/Code/proj-a",
        slug: "slug-2",
        startTime: "2025-03-18T11:00:00Z",
        durationMs: 120_000,
        promptCount: 1,
        toolCallCount: 1,
        editCount: 0,
        filesModified: [],
        tokenUsage: {
          inputTokens: 300,
          outputTokens: 75,
          cacheReadTokens: 40,
          cacheCreationTokens: 25,
        },
        turnDurations: [90_000, 720_000],
        subAgentCount: 0,
        apiErrorCount: 0,
        compactionCount: 0,
      },
    ]);

    expect(insights.tokenBreakdown).toEqual({
      input: 400,
      output: 125,
      cacheRead: 60,
      cacheCreation: 35,
    });
    expect(insights.medianTurnDurationMs).toBe(67500);
    expect(insights.turnDurationHistogram?.totalTurns).toBe(4);
    expect(insights.turnDurationHistogram?.buckets.map((bucket) => bucket.count)).toEqual([
      1, 1, 1, 0, 0, 1,
    ]);
  });
});
