import { describe, expect, it } from "vitest";
import { __testables, countComposerConversationHeaders } from "./sqlite-reader.js";

describe("countComposerConversationHeaders", () => {
  it("returns zero when headers are missing", () => {
    expect(countComposerConversationHeaders({})).toBe(0);
  });

  it("returns zero when headers are not an array", () => {
    expect(countComposerConversationHeaders({ fullConversationHeadersOnly: "oops" })).toBe(0);
  });

  it("returns array length for replayable composer payloads", () => {
    expect(
      countComposerConversationHeaders({
        fullConversationHeadersOnly: [{ bubbleId: "a" }, { bubbleId: "b" }, { bubbleId: "c" }],
      }),
    ).toBe(3);
  });
});

describe("cursor sqlite metrics helpers", () => {
  it("retries async initializer after a failure", async () => {
    let calls = 0;
    const init = __testables.createRetryableInit(async () => {
      calls++;
      if (calls === 1) throw new Error("init failed");
      return "ok";
    });

    await expect(init()).rejects.toThrow("init failed");
    await expect(init()).resolves.toBe("ok");
    await expect(init()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("computes token increments from cumulative snapshots", () => {
    const first = __testables.estimateTokenIncrement(
      {
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      undefined,
    );
    expect(first.increment).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });

    const second = __testables.estimateTokenIncrement(
      {
        inputTokens: 1500,
        outputTokens: 140,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      first.nextSnapshot,
    );
    expect(second.increment).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("handles token snapshot resets without negative deltas", () => {
    const reset = __testables.estimateTokenIncrement(
      {
        inputTokens: 120,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        inputTokens: 500,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    );
    expect(reset.increment).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("builds dense global-state turn stats aligned to user turns", () => {
    const metrics = __testables.buildGlobalStateMetrics(
      [
        {
          turn: { role: "user", blocks: [{ type: "text", text: "first prompt" }] },
          bubble: { type: 1, tokenCount: { inputTokens: 0, outputTokens: 0 } },
        },
        {
          turn: { role: "assistant", blocks: [{ type: "text", text: "first reply" }] },
          bubble: {
            type: 2,
            tokenCount: { inputTokens: 1000, outputTokens: 80 },
            modelInfo: { modelName: "claude-4.6-opus-high-thinking" },
          },
        },
        {
          turn: { role: "user", blocks: [{ type: "text", text: "second prompt" }] },
          bubble: { type: 1, tokenCount: { inputTokens: 0, outputTokens: 0 } },
        },
      ] as any,
      "claude-4.6-opus-high-thinking",
    );

    expect(metrics.turnStats).toHaveLength(2);
    expect(metrics.turnStats?.[0]?.tokenUsage?.outputTokens).toBe(80);
    expect(metrics.turnStats?.[1]?.tokenUsage).toBeUndefined();
  });

  it("extracts Cursor branch metadata from composer payload", () => {
    const branchMeta = __testables.extractCursorBranchMetadata({
      createdOnBranch: "feature/start",
      branches: [
        { branchName: "main" },
        { branchName: "feature/work" },
        { branchName: "feature/work" },
      ],
      committedToBranch: "feature/work",
      prBranchName: "feature/pr",
      activeBranch: { branchName: "feature/final" },
    });

    expect(branchMeta.gitBranch).toBe("feature/final");
    expect(branchMeta.gitBranches).toEqual([
      "feature/start",
      "main",
      "feature/work",
      "feature/pr",
      "feature/final",
    ]);
  });

  it("sorts Cursor branch history by last interaction before choosing current branch", () => {
    const branchMeta = __testables.extractCursorBranchMetadata({
      branches: [
        { branchName: "feature/current", lastInteractionAt: 20 },
        { branchName: "feature/old", lastInteractionAt: 10 },
      ],
      activeBranch: { branchName: "feature/current", lastInteractionAt: 20 },
    });

    expect(branchMeta.gitBranch).toBe("feature/current");
    expect(branchMeta.gitBranches).toEqual(["feature/old", "feature/current"]);
  });

  it("extracts remote workspace roots from composer path hints", () => {
    expect(
      __testables.inferProjectRootFromPathHint("/workspaces/api/src/resolvers/export.ts\\"),
    ).toBe("/workspaces/api");
    expect(
      __testables.inferProjectRootFromPathHint("/workspaces/.devcontainer/docker-compose.yml"),
    ).toBe("/workspaces");
    expect(__testables.inferProjectRootFromPathHint("/home/node/.config/git/config")).toBeNull();
  });

  it("normalizes composite Cursor model labels to the latest distinct model", () => {
    expect(
      __testables.normalizeCursorModelName(
        "gpt-5.2-high,claude-4.6-opus-high-thinking,claude-4.6-opus-high-thinking",
      ),
    ).toBe("claude-4.6-opus-high-thinking");
  });

  it("merges turn stats by preferring primary fields and enrichment gaps", () => {
    expect(__testables.mergeTurnStats(undefined, undefined)).toBeUndefined();
    expect(__testables.mergeTurnStats([{ turnIndex: 0 } as any], undefined)).toEqual([
      { turnIndex: 0 },
    ]);
    expect(__testables.mergeTurnStats(undefined, [{ turnIndex: 1 } as any])).toEqual([
      { turnIndex: 1 },
    ]);

    expect(
      __testables.mergeTurnStats(
        [
          {
            turnIndex: 0,
            model: "gpt-5.4-high",
          },
          {
            turnIndex: 2,
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 2,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          },
        ] as any,
        [
          {
            turnIndex: 0,
            durationMs: 4200,
            contextTokens: 900,
          },
          {
            turnIndex: 1,
            model: "claude-4.6-opus-high-thinking",
          },
        ] as any,
      ),
    ).toEqual([
      {
        turnIndex: 0,
        model: "gpt-5.4-high",
        durationMs: 4200,
        contextTokens: 900,
      },
      {
        turnIndex: 1,
        model: "claude-4.6-opus-high-thinking",
      },
      {
        turnIndex: 2,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      },
    ]);
  });

  it("extracts Cursor PR links from bubble payloads and deduplicates by URL", () => {
    const links = __testables.extractCursorPrLinks([
      {
        bubble: {
          pullRequests: [
            {
              number: 42,
              url: "https://github.com/acme/vibe-replay/pull/42",
            },
            {
              prNumber: 42,
              prUrl: "https://github.com/acme/vibe-replay/pull/42",
            },
            {
              prUrl: "https://github.com/acme/another/pull/99",
              prRepository: "acme/another",
            },
          ],
        },
      },
    ] as any);

    expect(links).toEqual([
      {
        prNumber: 42,
        prUrl: "https://github.com/acme/vibe-replay/pull/42",
        prRepository: "acme/vibe-replay",
      },
      {
        prNumber: 99,
        prUrl: "https://github.com/acme/another/pull/99",
        prRepository: "acme/another",
      },
    ]);
  });

  it("extracts Cursor API errors from bubble errorDetails", () => {
    const apiErrors = __testables.extractCursorApiErrors([
      {
        turnTimestamp: "2026-03-20T10:00:00.000Z",
        bubble: {
          createdAt: Date.parse("2026-03-20T10:00:00.000Z"),
          retryAttempt: 2,
          errorDetails: {
            generationUUID: "gen-1",
            message: "Error",
            error:
              '{"error":"ERROR_USER_ABORTED_REQUEST","details":{"title":"User aborted request."},"isExpected":true}',
          },
        },
      },
    ] as any);

    expect(apiErrors).toEqual([
      {
        timestamp: "2026-03-20T10:00:00.000Z",
        errorType: "ERROR_USER_ABORTED_REQUEST",
        retryAttempt: 2,
      },
    ]);
  });

  it("extracts Cursor context files from bubbles and request sidecars", () => {
    const summary = __testables.extractCursorContextSummary(
      [
        {
          bubble: {
            relevantFiles: ["src/auth.ts", "src/index.ts", "src/auth.ts"],
            recentlyViewedFiles: [{ path: "docs/plan.md" }],
          },
        },
      ] as any,
      [
        {
          terminalFiles: [{ filePath: "logs/dev.log" }],
          cursorRules: ['{"name":"instructions","body":"Always lint"}'],
          attachedFoldersListDirResults: [
            '{"directoryRelativeWorkspacePath":"src","files":[{"name":"utils.ts"}]}',
          ],
        },
      ],
    );

    expect(summary.contextFiles).toEqual([
      "src/auth.ts",
      "src/index.ts",
      "docs/plan.md",
      "logs/dev.log",
      "src/utils.ts",
    ]);
    expect(summary.requestContextCount).toBe(1);
    expect(summary.hasRequestContextSidecars).toBe(true);
    expect(summary.hasCursorRules).toBe(true);
  });

  it("strips hidden planning text from Cursor thinking payloads", () => {
    expect(
      __testables.parseThinking(
        [
          "**Waiting for generation**",
          "",
          "I need to wait for the generation to complete before checking the page.",
          "I might inspect the network if the button stays disabled.",
        ].join("\n"),
      ),
    ).toBe("");

    expect(
      __testables.parseThinking(
        [
          "Short visible note",
          "",
          "**Planning next steps**",
          "",
          "I need to inspect the parser before deciding how to fix it.",
          "I should compare the SQLite path too.",
        ].join("\n"),
      ),
    ).toBe("Short visible note");
  });

  it("strips hidden planning tails from store-backed assistant content", () => {
    const blocks = __testables.parseAssistantContent(
      [
        {
          type: "text",
          text: [
            "我先验证一下本地生成链路。",
            "",
            "**Exploring tool functions**",
            "",
            "I need to inspect the current session and compare the SQLite path.",
            "I should verify whether tool-call blocks already contain enough metadata.",
          ].join("\n"),
        },
        {
          type: "reasoning",
          text: [
            "**Waiting for generation**",
            "",
            "I need to wait for the replay generation to finish.",
            "I might inspect the network if the page does not navigate.",
          ].join("\n"),
        },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "ReadFile",
          args: { path: "/tmp/demo.ts" },
        },
      ] as any,
      new Map(),
    );

    expect(blocks).toEqual([
      { type: "text", text: "我先验证一下本地生成链路。" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "/tmp/demo.ts" },
        _result: "",
      },
    ]);
  });

  it("keeps non-planning bold headings in assistant content", () => {
    const blocks = __testables.parseAssistantContent(
      [
        {
          type: "text",
          text: [
            "**Why this fix works**",
            "",
            "I need to mention that this function has a subtle bug.",
            "I should explain why before I fix it.",
          ].join("\n"),
        },
      ] as any,
      new Map(),
    );

    expect(blocks).toEqual([
      {
        type: "text",
        text: [
          "**Why this fix works**",
          "",
          "I need to mention that this function has a subtle bug.",
          "I should explain why before I fix it.",
        ].join("\n"),
      },
    ]);
  });

  it("extracts API errors even when the error bubble has no replayable turn content", () => {
    const apiErrors = __testables.extractCursorApiErrors([
      {
        bubble: {
          createdAt: Date.parse("2026-03-20T10:00:00.000Z"),
          errorDetails: {
            error:
              '{"error":"ERROR_EXTENSION_HOST_TIMEOUT","details":{"title":"Agent Stream Start Timeout"}}',
          },
        },
      },
    ] as any);

    expect(apiErrors).toEqual([
      {
        timestamp: "2026-03-20T10:00:00.000Z",
        errorType: "ERROR_EXTENSION_HOST_TIMEOUT",
      },
    ]);
  });

  it("keeps distinct Cursor API errors when only the error type differs", () => {
    const apiErrors = __testables.extractCursorApiErrors([
      {
        bubble: {
          createdAt: Date.parse("2026-03-20T10:00:00.000Z"),
          errorDetails: {
            error: '{"error":"ERROR_EXTENSION_HOST_TIMEOUT"}',
          },
        },
      },
      {
        bubble: {
          createdAt: Date.parse("2026-03-20T10:00:00.000Z"),
          errorDetails: {
            error: '{"error":"ERROR_RATE_LIMITED"}',
          },
        },
      },
    ] as any);

    expect(apiErrors).toEqual([
      {
        timestamp: "2026-03-20T10:00:00.000Z",
        errorType: "ERROR_EXTENSION_HOST_TIMEOUT",
      },
      {
        timestamp: "2026-03-20T10:00:00.000Z",
        errorType: "ERROR_RATE_LIMITED",
      },
    ]);
  });

  it("merges global-state metadata into store-backed Cursor parses", () => {
    const merged = __testables.mergeCursorParseResults(
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "",
        turns: [{ role: "user", blocks: [{ type: "text", text: "prompt" }] }],
        dataSource: "sqlite",
        dataSourceInfo: {
          primary: "sqlite",
          sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
          notes: ["Token usage is unavailable for this Cursor SQLite session."],
        },
      },
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "/workspace/project",
        turns: [{ role: "assistant", blocks: [{ type: "text", text: "reply" }] }],
        dataSource: "global-state",
        dataSourceInfo: {
          primary: "global-state",
          sources: ["cursor/user/globalStorage/state.vscdb"],
          notes: [
            "Token usage is estimated from Cursor token snapshots.",
            "Duration is estimated from Cursor thinking and tool execution timing.",
            "Git branch is inferred from Cursor composer metadata.",
          ],
        },
        model: "claude-4.6-opus-high-thinking",
        totalDurationMs: 4200,
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 80,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        tokenUsageByModel: {
          "claude-4.6-opus-high-thinking": {
            inputTokens: 1200,
            outputTokens: 80,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
        turnStats: [
          {
            turnIndex: 0,
            model: "claude-4.6-opus-high-thinking",
            durationMs: 4200,
            tokenUsage: {
              inputTokens: 1200,
              outputTokens: 80,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
            },
          },
        ],
        gitBranch: "feat/auth",
        apiErrors: [{ timestamp: "2026-03-20T10:00:00.000Z", errorType: "rate_limit_error" }],
        contextFiles: ["src/auth.ts"],
        cursorSidecars: {
          requestContextCount: 2,
          checkpointCount: 6,
          hasWorkspaceRules: true,
        },
      },
    );

    expect(merged.dataSource).toBe("sqlite");
    expect(merged.turns).toHaveLength(1);
    expect(merged.cwd).toBe("/workspace/project");
    expect(merged.gitBranch).toBe("feat/auth");
    expect(merged.model).toBe("claude-4.6-opus-high-thinking");
    expect(merged.totalDurationMs).toBe(4200);
    expect(merged.tokenUsage).toMatchObject({ inputTokens: 1200, outputTokens: 80 });
    expect(merged.tokenUsageByModel).toHaveProperty("claude-4.6-opus-high-thinking");
    expect(merged.turnStats?.[0]).toMatchObject({
      turnIndex: 0,
      model: "claude-4.6-opus-high-thinking",
      durationMs: 4200,
    });
    expect(merged.apiErrors).toEqual([
      { timestamp: "2026-03-20T10:00:00.000Z", errorType: "rate_limit_error" },
    ]);
    expect(merged.contextFiles).toEqual(["src/auth.ts"]);
    expect(merged.cursorSidecars).toEqual({
      requestContextCount: 2,
      checkpointCount: 6,
      hasWorkspaceRules: true,
    });
    expect(merged.dataSourceInfo?.supplements).toContain("cursor/user/globalStorage/state.vscdb");
  });

  it("does not add enrichment notes when primary metadata already exists", () => {
    const merged = __testables.mergeCursorParseResults(
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "",
        gitBranch: "feat/existing",
        turns: [{ role: "user", blocks: [{ type: "text", text: "prompt" }] }],
        dataSource: "sqlite",
        dataSourceInfo: {
          primary: "sqlite",
          sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
          notes: ["Token usage is unavailable for this Cursor SQLite session."],
        },
      },
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "/workspace/project",
        turns: [{ role: "assistant", blocks: [{ type: "text", text: "reply" }] }],
        dataSource: "global-state",
        dataSourceInfo: {
          primary: "global-state",
          sources: ["cursor/user/globalStorage/state.vscdb"],
          notes: ["Git branch is inferred from Cursor composer metadata."],
        },
        gitBranch: "feat/enriched",
      },
    );

    expect(merged.gitBranch).toBe("feat/existing");
    expect(merged.dataSourceInfo?.notes).toEqual([
      "Token usage is unavailable for this Cursor SQLite session.",
    ]);
  });

  it("does not add enrichment notes when global-state contributes no merged metadata", () => {
    const merged = __testables.mergeCursorParseResults(
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "/workspace/project",
        turns: [{ role: "user", blocks: [{ type: "text", text: "prompt" }] }],
        dataSource: "sqlite",
        dataSourceInfo: {
          primary: "sqlite",
          sources: ["cursor/chats/<workspace-hash>/<session-id>/store.db"],
          notes: ["Token usage is unavailable for this Cursor SQLite session."],
        },
      },
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "/workspace/project",
        turns: [{ role: "assistant", blocks: [{ type: "text", text: "reply" }] }],
        dataSource: "global-state",
        dataSourceInfo: {
          primary: "global-state",
          sources: ["cursor/user/globalStorage/state.vscdb"],
          notes: ["Duration is unavailable for this Cursor global-state session."],
        },
      },
    );

    expect(merged.dataSourceInfo?.notes).toEqual([
      "Token usage is unavailable for this Cursor SQLite session.",
    ]);
  });

  it("normalizes file URIs in Cursor context files", () => {
    const summary = __testables.extractCursorContextSummary(
      [
        {
          bubble: {
            relevantFiles: [{ uri: "file:///Users/test/project/src/auth%20flow.ts" }],
          },
        },
      ] as any,
      [],
    );

    expect(summary.contextFiles).toEqual(["/Users/test/project/src/auth flow.ts"]);
  });

  it("keeps existing Cursor sidecars when primary parse already has them", () => {
    const merged = __testables.mergeCursorParseResults(
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "",
        turns: [{ role: "user", blocks: [{ type: "text", text: "prompt" }] }],
        cursorSidecars: {
          requestContextCount: 1,
          hasWorkspaceRules: false,
        },
      },
      {
        sessionId: "sess-1",
        slug: "sess-1",
        cwd: "/workspace/project",
        turns: [{ role: "assistant", blocks: [{ type: "text", text: "reply" }] }],
        cursorSidecars: {
          requestContextCount: 2,
          checkpointCount: 6,
          hasWorkspaceRules: true,
        },
      },
    );

    expect(merged.cursorSidecars).toEqual({
      requestContextCount: 1,
      checkpointCount: 6,
      hasWorkspaceRules: false,
    });
  });

  it("builds dense store turn stats aligned to user turns", () => {
    const turnStats = __testables.buildStoreTurnStats([
      {
        role: "user",
        blocks: [{ type: "text", text: "first prompt" }],
      },
      {
        role: "assistant",
        model: "gpt-5.3-codex-high",
        blocks: [{ type: "tool_use", id: "1", name: "Bash", input: {}, _durationMs: 1200 } as any],
      },
      {
        role: "user",
        blocks: [{ type: "text", text: "second prompt" }],
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "plain reply without tool duration" }],
      },
    ] as any);

    expect(turnStats).toHaveLength(2);
    expect(turnStats[0]).toMatchObject({ turnIndex: 0, durationMs: 1200 });
    expect(turnStats[1]).toMatchObject({ turnIndex: 1 });
    expect(turnStats[1].durationMs).toBeUndefined();
  });

  it("treats empty store roots as non-replayable", () => {
    expect(__testables.hasReplayableRootBlob(new Uint8Array())).toBe(false);
    expect(__testables.hasReplayableRootBlob(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });

  it("detects replayable store roots with linked child blob ids", () => {
    const replayableRoot = new Uint8Array([
      0xff,
      0x0a,
      0x20,
      ...Array.from({ length: 32 }, (_, i) => i + 1),
      0xee,
    ]);
    expect(__testables.hasReplayableRootBlob(replayableRoot)).toBe(true);
  });

  it("drops system context wrapped in user_query from sqlite user content", () => {
    const blocks = __testables.parseUserContent(
      "<user_query>\n<system_reminder>\ninternal only\n</system_reminder>\n</user_query>",
    );
    expect(blocks).toEqual([]);
  });

  it("keeps normal user_query content from sqlite user content", () => {
    const blocks = __testables.parseUserContent(
      "<user_query>\nShip this fix\n</user_query>",
    ) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("Ship this fix");
  });

  it("normalizes turn text and drops wrapped system context", () => {
    expect(
      __testables.normalizeTurnText(
        "<user_query>\n<agent_transcripts>\ninternal block\n</agent_transcripts>\n</user_query>",
      ),
    ).toBe("");
    expect(__testables.normalizeTurnText("<user_query>\nFix auth bug\n</user_query>")).toBe(
      "Fix auth bug",
    );
  });

  it("maps ApplyPatch into Edit with diff-like args", () => {
    expect(__testables.mapCursorToolName("ApplyPatch")).toBe("Edit");
    const mapped = __testables.mapToolArgs(
      "ApplyPatch",
      "*** Begin Patch\n*** Update File: /tmp/demo.ts\n@@\n-old line\n+new line\n*** End Patch",
    ) as any;
    expect(mapped.file_path).toBe("/tmp/demo.ts");
    expect(mapped.old_string).toContain("old line");
    expect(mapped.new_string).toContain("new line");
  });

  it("maps apply_patch object args with relativeWorkspacePath", () => {
    const mapped = __testables.mapToolArgs(
      "apply_patch",
      { relativeWorkspacePath: "src/c.ts" },
      JSON.stringify({
        diff: {
          chunks: [{ diffString: "@@\n-old c\n+new c" }],
        },
      }),
    ) as any;
    expect(mapped.file_path).toBe("src/c.ts");
    expect(mapped.old_string).toContain("old c");
    expect(mapped.new_string).toContain("new c");
  });

  it("preserves context lines when parsing ApplyPatch diff text", () => {
    const mapped = __testables.mapToolArgs(
      "ApplyPatch",
      "*** Begin Patch\n*** Update File: /tmp/ctx.ts\n@@\n shared before\n-old value\n+new value\n shared after\n*** End Patch",
    ) as any;
    expect(mapped.old_string).toContain("shared before");
    expect(mapped.old_string).toContain("shared after");
    expect(mapped.new_string).toContain("shared before");
    expect(mapped.new_string).toContain("shared after");
  });

  it("maps global-state Cursor tool aliases to canonical names", () => {
    expect(__testables.mapCursorToolName("run_terminal_cmd")).toBe("Bash");
    expect(__testables.mapCursorToolName("read_file")).toBe("Read");
    expect(__testables.mapCursorToolName("search_replace")).toBe("Edit");
    expect(__testables.mapCursorToolName("edit_file")).toBe("Edit");
    expect(__testables.mapCursorToolName("write")).toBe("Write");
    expect(__testables.mapCursorToolName("Task")).toBe("Agent");
    expect(__testables.mapCursorToolName("task_v2")).toBe("Agent");
    expect(__testables.mapCursorToolName("create_plan")).toBe("Plan");
    expect(
      __testables.mapCursorToolName("mcp-cursor-ide-browser-cursor-ide-browser-browser_navigate"),
    ).toBe("Browser");
    expect(__testables.mapCursorToolName("chrome-devtools-new_page")).toBe("Browser");
    expect(__testables.mapCursorToolName("list_dir")).toBe("Glob");
    expect(__testables.mapCursorToolName("rg")).toBe("Grep");
    expect(__testables.mapCursorToolName("grep_search")).toBe("Grep");
    expect(__testables.mapCursorToolName("ripgrep")).toBe("Grep");
    expect(__testables.mapCursorToolName("file_search")).toBe("Glob");
    expect(__testables.mapCursorToolName("codebase_search")).toBe("SemanticSearch");
  });

  it("maps Cursor task args into Agent-style subagent metadata", () => {
    const mapped = __testables.mapToolArgs("task_v2", {
      description: "Search auth patterns",
      prompt: "Search auth patterns in the repo",
      subagentType: "Explore",
    }) as any;
    expect(mapped).toEqual({
      description: "Search auth patterns",
      prompt: "Search auth patterns in the repo",
      subagent_type: "Explore",
    });
  });

  it("maps run_terminal_cmd and read_file args into normalized shape", () => {
    const run = __testables.mapToolArgs("run_terminal_cmd", {
      command: "git status",
      requireUserApproval: true,
    }) as any;
    expect(run).toMatchObject({ command: "git status", requireUserApproval: true });

    const read = __testables.mapToolArgs("read_file", {
      targetFile: "/tmp/a.ts",
    }) as any;
    expect(read).toEqual({ file_path: "/tmp/a.ts" });
  });

  it("maps search_replace args and infers old/new snippets from result payload", () => {
    const mapped = __testables.mapToolArgs(
      "search_replace",
      { relativeWorkspacePath: "/tmp/a.ts" },
      JSON.stringify({
        diff: {
          chunks: [{ diffString: "@@\n-const a = 1;\n+const a = 2;" }],
        },
      }),
    ) as any;
    expect(mapped.file_path).toBe("/tmp/a.ts");
    expect(mapped.old_string).toContain("const a = 1;");
    expect(mapped.new_string).toContain("const a = 2;");
  });

  it("maps canonical Edit args when Cursor stores relativeWorkspacePath", () => {
    const mapped = __testables.mapToolArgs(
      "Edit",
      { relativeWorkspacePath: "src/a.ts" },
      JSON.stringify({
        diff: {
          chunks: [{ diffString: "@@\n-old value\n+new value" }],
        },
      }),
    ) as any;
    expect(mapped.file_path).toBe("src/a.ts");
    expect(mapped.old_string).toContain("old value");
    expect(mapped.new_string).toContain("new value");
  });

  it("maps EditFile args with relativeWorkspacePath", () => {
    const mapped = __testables.mapToolArgs("EditFile", {
      relativeWorkspacePath: "src/b.ts",
      oldStr: "a",
      newStr: "b",
    }) as any;
    expect(mapped).toEqual({ file_path: "src/b.ts", old_string: "a", new_string: "b" });
  });

  it("maps lowercase write and list_dir variants", () => {
    const write = __testables.mapToolArgs("write", {
      relativeWorkspacePath: "/tmp/doc.md",
      code: { code: "# title" },
    }) as any;
    expect(write).toEqual({ file_path: "/tmp/doc.md", content: "# title" });

    const ls = __testables.mapToolArgs("list_dir", {
      targetDirectory: "/tmp",
    }) as any;
    expect(ls).toEqual({ path: "/tmp" });
  });

  it("maps canonical Write args when Cursor stores relativeWorkspacePath + code object", () => {
    const mapped = __testables.mapToolArgs("Write", {
      relativeWorkspacePath: "docs/readme.md",
      code: { code: "hello" },
    }) as any;
    expect(mapped).toEqual({ file_path: "docs/readme.md", content: "hello" });
  });

  it("maps Delete args across Cursor variants", () => {
    const canonical = __testables.mapToolArgs("Delete", {
      path: "docs/old.md",
    }) as any;
    expect(canonical).toEqual({ file_path: "docs/old.md" });

    const legacy = __testables.mapToolArgs("delete_file", {
      relativeWorkspacePath: "src/obsolete.ts",
    }) as any;
    expect(legacy).toEqual({ file_path: "src/obsolete.ts" });
  });

  it("keeps string tool args as raw text for unknown tools", () => {
    const mapped = __testables.mapToolArgs("CustomTool", "plain text payload") as any;
    expect(mapped).toEqual({ raw: "plain text payload" });
  });
});
